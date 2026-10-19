/**
 * Makes arbitrary text safe for a PDF that uses the built-in standard
 * fonts (Helvetica). Those fonts can only draw Windows-1252 ("WinAnsi")
 * characters; anything else would render as garbage or break the
 * document. Export text comes from reports and user input (evidence
 * quotes, dismissal reasons, filenames), so it can contain anything.
 *
 * Standard fonts are used on purpose: they keep exported text
 * selectable and screen-reader accessible (PRD Section 23/accessibility)
 * without bundling a font file.
 *
 * Unsupported characters become "?" — visibly lossy rather than
 * silently wrong. Common typographic look-alikes are transliterated.
 */

const TRANSLITERATIONS: Record<string, string> = {
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\u2192": "->",
  "\u2190": "<-",
  "\u2265": ">=",
  "\u2264": "<=",
  "\u2260": "!=",
  "\u00A0": " ",
  "\u2009": " ",
  "\u200B": "",
  "\uFEFF": "",
};

/** Windows-1252 characters outside Latin-1 that the standard fonts can draw. */
const WIN_ANSI_EXTRAS = new Set(
  "\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178".split(
    ""
  )
);

function isDrawable(char: string): boolean {
  const code = char.codePointAt(0)!;
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return WIN_ANSI_EXTRAS.has(char);
}

export function toPdfSafeText(value: string): string {
  let out = "";
  for (const char of value.replace(/[\r\n\t]+/g, " ")) {
    const replacement = TRANSLITERATIONS[char];
    if (replacement !== undefined) {
      out += replacement;
    } else if (isDrawable(char)) {
      out += char;
    } else if (/\p{Cc}|\p{Cf}/u.test(char)) {
      // Control/format characters: drop rather than show "?".
    } else {
      out += "?";
    }
  }
  return out.replace(/ {2,}/g, " ").trim();
}
