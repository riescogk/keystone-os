import { deflateRawSync } from "node:zlib";

/**
 * Builds small ZIP archives in memory for tests, including deliberately
 * hostile ones (encrypted flag, declared sizes that lie, duplicate names)
 * that a real Excel file never produces.
 */

export interface TestEntry {
  name: string;
  data?: Uint8Array | string;
  /** 0 = stored, 8 = deflate. Default 0. */
  method?: 0 | 8;
  /** Overrides the uncompressed size written to the headers (to test lying archives). */
  declaredSize?: number;
  /** Sets general-purpose flag bit 0 (encryption). */
  encrypted?: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: TestEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw =
      typeof entry.data === "string"
        ? encoder.encode(entry.data)
        : entry.data ?? new Uint8Array(0);
    const method = entry.method ?? 0;
    const stored = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const size = entry.declaredSize ?? raw.length;
    const flags = entry.encrypted ? 0x0001 : 0;
    const checksum = crc32(raw);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, method, true);
    local.setUint32(14, checksum, true);
    local.setUint32(18, stored.length, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);

    const localBytes = new Uint8Array(30 + name.length);
    localBytes.set(new Uint8Array(local.buffer), 0);
    localBytes.set(name, 30);
    chunks.push(localBytes, stored);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, flags, true);
    header.setUint16(10, method, true);
    header.setUint32(16, checksum, true);
    header.setUint32(20, stored.length, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    const centralBytes = new Uint8Array(46 + name.length);
    centralBytes.set(new Uint8Array(header.buffer), 0);
    centralBytes.set(name, 46);
    central.push(centralBytes);

    offset += localBytes.length + stored.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let position = 0;
  for (const part of [...chunks, ...central, new Uint8Array(end.buffer)]) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
