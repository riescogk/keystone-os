import { inflateRawSync } from "node:zlib";
import { SourceWorkbookError } from "@/lib/review/source/errors";

/**
 * A minimal, read-only ZIP reader for OOXML packages (.xlsx / .xlsm).
 *
 * Why not a general library: this only ever needs to read a handful of
 * named parts (workbook.xml, sheets, rels, styles). Writing the reader here
 * lets every size limit and refusal be explicit and tested, and avoids
 * adding a dependency to the review path.
 *
 * Security properties:
 * - Entries are only ever read by exact name. Nothing is extracted to disk,
 *   so path-traversal names are never resolved to a filesystem location.
 * - Declared sizes are summed BEFORE any decompression. A package whose
 *   declared total exceeds the budget is rejected up front (zip-bomb guard),
 *   and inflation is capped at each entry's declared size.
 * - Encrypted entries, ZIP64 archives, duplicate names, and compression
 *   methods other than "stored" and "deflate" are refused.
 * - Callers can list entries without reading them, which is how macro parts
 *   (xl/vbaProject.bin) are detected: they are never read or inflated.
 */

export interface ZipLimits {
  maxEntries: number;
  /** Budget for the sum of declared uncompressed sizes of every entry. */
  maxDeclaredBytes: number;
  /** Budget for the total bytes this reader will actually inflate. */
  maxReadBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2000,
  maxDeclaredBytes: 200 * 1024 * 1024,
  maxReadBytes: 200 * 1024 * 1024,
};

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipArchive {
  readonly entries: ReadonlyMap<string, ZipEntry>;
  has(name: string): boolean;
  /** Returns the decompressed bytes of one entry, or null if absent. */
  read(name: string): Uint8Array | null;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;

function unreadable(detail: string): SourceWorkbookError {
  return new SourceWorkbookError("unreadable", detail);
}

export function openZipArchive(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS
): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate the end-of-central-directory record. It sits at the end of the
  // file, possibly followed by a comment of up to 64 KB.
  let eocd = -1;
  const earliest = Math.max(0, bytes.length - EOCD_MIN_SIZE - MAX_COMMENT_SIZE);
  for (let i = bytes.length - EOCD_MIN_SIZE; i >= earliest; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unreadable("no end-of-central-directory record");

  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  // 0xFFFF / 0xFFFFFFFF are ZIP64 sentinels. Excel's own files never need
  // ZIP64 at this size, so treat them as unsupported rather than guessing.
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new SourceWorkbookError("unsupported", "ZIP64 archives are not supported");
  }
  if (entryCount > limits.maxEntries) {
    throw new SourceWorkbookError("too_large", "too many package parts");
  }
  if (centralOffset + centralSize > bytes.length) {
    throw unreadable("central directory outside the file");
  }

  const entries = new Map<string, ZipEntry>();
  let declaredTotal = 0;
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw unreadable("malformed central directory");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) throw unreadable("truncated entry name");
    const name = buffer.toString("utf8", nameStart, nameEnd);

    if (flags & FLAG_ENCRYPTED) {
      throw new SourceWorkbookError("encrypted", "encrypted package entry");
    }
    if (entries.has(name)) {
      // Two entries with one name make "which part is the workbook?"
      // ambiguous, so refuse rather than pick one.
      throw new SourceWorkbookError("unsupported", "duplicate package part name");
    }

    declaredTotal += uncompressedSize;
    if (declaredTotal > limits.maxDeclaredBytes) {
      throw new SourceWorkbookError("too_large", "declared size exceeds the limit");
    }

    entries.set(name, {
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor = nameEnd + extraLength + commentLength;
  }

  let readTotal = 0;

  function read(name: string): Uint8Array | null {
    const entry = entries.get(name);
    if (!entry) return null;

    if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      throw new SourceWorkbookError("unsupported", "unsupported compression method");
    }

    readTotal += entry.uncompressedSize;
    if (readTotal > limits.maxReadBytes) {
      throw new SourceWorkbookError("too_large", "workbook is too large to read");
    }

    const local = entry.localHeaderOffset;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
      throw unreadable("malformed local header");
    }
    const dataStart =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length) throw unreadable("truncated entry data");

    const compressed = buffer.subarray(dataStart, dataEnd);
    let output: Buffer;
    try {
      output =
        entry.method === METHOD_STORED
          ? Buffer.from(compressed)
          : inflateRawSync(compressed, {
              // Capped at the declared size, so a lying header cannot
              // expand past what the central directory promised.
              maxOutputLength: Math.max(1, entry.uncompressedSize),
            });
    } catch {
      throw unreadable("entry failed to decompress");
    }
    if (output.length !== entry.uncompressedSize) {
      throw unreadable("entry size does not match its header");
    }
    return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
  }

  return {
    entries,
    has: (name) => entries.has(name),
    read,
  };
}
