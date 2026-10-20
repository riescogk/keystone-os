/**
 * A1-style reference parsing (pure). Used for cell addresses, range
 * strings in defined names, and table `ref` attributes.
 */

export interface CellAddress {
  row: number; // 1-based
  col: number; // 1-based
}

export interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export function columnNumberFromLetters(letters: string): number {
  let value = 0;
  for (const char of letters.toUpperCase()) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value;
}

export function columnLettersFromNumber(column: number): string {
  let value = column;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;

export function parseA1(reference: string): CellAddress | null {
  const match = CELL.exec(reference.trim());
  if (!match) return null;
  const row = Number(match[2]);
  const col = columnNumberFromLetters(match[1]);
  if (!Number.isInteger(row) || row < 1 || row > 1_048_576) return null;
  if (col < 1 || col > 16_384) return null;
  return { row, col };
}

/** "B5" or "B5:D9" (with optional $ anchors) -> range. Single cell -> start == end. */
export function parseRangeText(text: string): CellRange | null {
  const parts = text.trim().split(":");
  if (parts.length === 0 || parts.length > 2) return null;
  const start = parseA1(parts[0]);
  if (!start) return null;
  const end = parts.length === 2 ? parseA1(parts[1]) : start;
  if (!end) return null;
  return {
    startRow: Math.min(start.row, end.row),
    startCol: Math.min(start.col, end.col),
    endRow: Math.max(start.row, end.row),
    endCol: Math.max(start.col, end.col),
  };
}

export function isSingleCell(range: CellRange): boolean {
  return range.startRow === range.endRow && range.startCol === range.endCol;
}

export function cellReference(row: number, col: number): string {
  return `${columnLettersFromNumber(col)}${row}`;
}

export function rangeReference(range: CellRange): string {
  const start = cellReference(range.startRow, range.startCol);
  if (isSingleCell(range)) return start;
  return `${start}:${cellReference(range.endRow, range.endCol)}`;
}

export function rangeContains(range: CellRange, row: number, col: number): boolean {
  return (
    row >= range.startRow &&
    row <= range.endRow &&
    col >= range.startCol &&
    col <= range.endCol
  );
}
