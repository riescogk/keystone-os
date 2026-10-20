import { SourceWorkbookError } from "@/lib/review/source/errors";
import {
  MAIN_CONTENT_TYPE_BY_FORMAT,
  type WorkbookFormat,
} from "@/lib/review/source/workbookFile";
import type { ZipArchive } from "@/lib/review/source/zipArchive";
import { childrenNamed, parseXml } from "@/lib/review/source/xmlTree";

/**
 * Structural checks on an OOXML workbook package, performed without
 * reading any sheet data or executing anything.
 *
 * Used at upload (to reject a bad file before anything is stored) and again
 * at review time. It deliberately does NOT read xl/vbaProject.bin or any
 * external-link target: their presence is recorded from the archive's
 * directory listing alone.
 */

export interface PackageInspection {
  /** True if the package carries a VBA project. It is never read or run. */
  containsMacros: boolean;
  /** Number of external-link parts. Their targets are never followed. */
  externalLinkCount: number;
}

const REQUIRED_PARTS = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"];
const EXTERNAL_LINK_PART = /^xl\/externalLinks\/externalLink\d+\.xml$/;

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function inspectWorkbookPackage(
  archive: ZipArchive,
  expectedFormat: WorkbookFormat
): PackageInspection {
  for (const part of REQUIRED_PARTS) {
    if (!archive.has(part)) {
      throw new SourceWorkbookError("unreadable", `missing package part ${part}`);
    }
  }

  const contentTypes = archive.read("[Content_Types].xml");
  if (!contentTypes) throw new SourceWorkbookError("unreadable", "no content types");
  const types = parseXml(decodeText(contentTypes));
  const workbookOverride = childrenNamed(types, "Override").find(
    (node) => node.attributes.PartName === "/xl/workbook.xml"
  );
  const declared = workbookOverride?.attributes.ContentType;
  if (!declared) {
    throw new SourceWorkbookError("unreadable", "workbook part has no content type");
  }

  if (declared !== MAIN_CONTENT_TYPE_BY_FORMAT[expectedFormat]) {
    const otherFormat: WorkbookFormat = expectedFormat === "xlsx" ? "xlsm" : "xlsx";
    if (declared === MAIN_CONTENT_TYPE_BY_FORMAT[otherFormat]) {
      throw new SourceWorkbookError("format_mismatch", "extension does not match contents");
    }
    throw new SourceWorkbookError("unsupported", "not a standard Excel workbook");
  }

  let externalLinkCount = 0;
  for (const name of archive.entries.keys()) {
    if (EXTERNAL_LINK_PART.test(name)) externalLinkCount++;
  }

  return {
    containsMacros: archive.has("xl/vbaProject.bin"),
    externalLinkCount,
  };
}

/** Decodes an XML part from the archive, or throws if it is missing. */
export function readXmlPart(archive: ZipArchive, name: string) {
  const bytes = archive.read(name);
  if (!bytes) {
    throw new SourceWorkbookError("unreadable", `missing package part ${name}`);
  }
  return parseXml(decodeText(bytes));
}

export { decodeText };
