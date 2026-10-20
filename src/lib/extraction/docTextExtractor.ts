import WordExtractor from "word-extractor";

export interface DocEmbeddedReference {
  sheet: string;
  definedName: string;
}

export interface DocExtractionResult {
  text: string;
  embeddedReferences: DocEmbeddedReference[];
}

const EMBEDDED_REFERENCE_PATTERN =
  /([A-Za-z][A-Za-z &'().,_-]{0,100})!(N1[A-Za-z0-9_]+)/g;

function extractEmbeddedReferences(buffer: Uint8Array): DocEmbeddedReference[] {
  const raw = Buffer.from(buffer).toString("utf16le");
  const references: DocEmbeddedReference[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;

  while ((match = EMBEDDED_REFERENCE_PATTERN.exec(raw)) !== null) {
    const sheet = match[1].trim();
    const definedName = match[2];

    if (!sheet || !definedName) {
      continue;
    }

    const key = `${sheet.toLowerCase()}!${definedName.toLowerCase()}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    references.push({
      sheet,
      definedName,
    });
  }

  return references;
}

export async function extractDocText(
  buffer: Uint8Array
): Promise<DocExtractionResult> {
  const extractor = new WordExtractor();

  const document = await extractor.extract(Buffer.from(buffer));
  const text = document.getBody();

  if (!text || !text.trim()) {
    throw new Error("The Word document did not contain extractable text.");
  }

  return {
    text: text.trim(),
    embeddedReferences: extractEmbeddedReferences(buffer),
  };
}