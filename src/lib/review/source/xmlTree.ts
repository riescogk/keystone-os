import { SourceWorkbookError } from "@/lib/review/source/errors";

/**
 * A strict, small XML parser for OOXML parts (workbook.xml, sheets, styles,
 * sharedStrings, rels, content types, tables).
 *
 * This is deliberately not a general XML parser:
 * - DOCTYPE declarations and entity definitions are REJECTED. Excel never
 *   writes them, and refusing them removes the entity-expansion class of
 *   attacks entirely (no "billion laughs", no external entity fetches).
 * - Malformed input fails loudly. Every byte must be consumed by a valid
 *   token, so a truncated or corrupted part cannot silently produce a
 *   partial model that looks complete.
 * - Namespace prefixes are stripped from names (`x:c` -> `c`), so lookups
 *   use the local names defined by the OOXML spec.
 */

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Text written directly inside this element (not inside children). */
  text: string;
}

const MAX_DEPTH = 64;

/**
 * One token per call, matched at exactly `lastIndex` (sticky), so that any
 * byte the grammar does not cover causes a parse error instead of being
 * skipped.
 */
const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.\-]*(?::[\w.\-]+)?)((?:\s+[^\s=\/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!([^>]*)>|([^<]+)/y;

const ATTRIBUTE = /([^\s=\/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function localName(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon >= 0 ? qualified.slice(colon + 1) : qualified;
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return match;
    }
  });
}

function malformed(detail: string): SourceWorkbookError {
  return new SourceWorkbookError("unreadable", `malformed XML: ${detail}`);
}

export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#document", attributes: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let documentElement: XmlElement | null = null;
  let position = 0;

  TOKEN.lastIndex = 0;
  while (position < xml.length) {
    TOKEN.lastIndex = position;
    const match = TOKEN.exec(xml);
    if (!match) throw malformed("unexpected content");
    position = TOKEN.lastIndex;
    const [whole, cdata, closing, rawName, rawAttributes, selfClosing, declaration, text] = match;

    if (whole.startsWith("<!--") || whole.startsWith("<?")) {
      continue;
    }

    if (declaration !== undefined) {
      // Anything in <!...> that is not a comment: DOCTYPE, ENTITY, etc.
      throw new SourceWorkbookError("unsupported", "DTD or entity declarations are not supported");
    }

    if (cdata !== undefined) {
      stack[stack.length - 1].text += cdata;
      continue;
    }

    if (text !== undefined) {
      const top = stack[stack.length - 1];
      top.text += decodeEntities(text);
      continue;
    }

    if (closing) {
      const element = stack.pop();
      if (!element || stack.length === 0) throw malformed("unexpected end tag");
      if (element.name !== localName(rawName)) throw malformed("mismatched end tag");
      continue;
    }

    if (stack.length > MAX_DEPTH) {
      throw new SourceWorkbookError("too_large", "XML nesting is too deep");
    }

    const element: XmlElement = {
      name: localName(rawName),
      attributes: {},
      children: [],
      text: "",
    };
    if (rawAttributes) {
      ATTRIBUTE.lastIndex = 0;
      let attribute: RegExpExecArray | null;
      while ((attribute = ATTRIBUTE.exec(rawAttributes)) !== null) {
        const key = localName(attribute[1]);
        const value = decodeEntities(attribute[2] ?? attribute[3] ?? "");
        element.attributes[key] = value;
      }
    }

    const parent = stack[stack.length - 1];
    parent.children.push(element);
    if (documentElement === null && parent === root) {
      documentElement = element;
    }
    if (!selfClosing) {
      stack.push(element);
    }
  }

  if (stack.length !== 1) throw malformed("unclosed element");
  if (documentElement === null) throw malformed("no root element");
  return documentElement;
}

/** Direct children with the given local name, in document order. */
export function childrenNamed(element: XmlElement | undefined, name: string): XmlElement[] {
  if (!element) return [];
  return element.children.filter((child) => child.name === name);
}

export function firstChild(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return childrenNamed(element, name)[0];
}

/** All text inside an element and its descendants, in document order. */
export function textOf(element: XmlElement): string {
  return element.text + element.children.map(textOf).join("");
}
