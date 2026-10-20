import { parseA1, parseRangeText } from "@/lib/review/source/cellRef";
import type { CellRecord, WorkbookModel } from "@/lib/review/source/workbookModel";

/**
 * Tiny, intentionally non-general formula verifier. It NEVER evaluates
 * arbitrary Excel expressions. It supports only same-sheet numeric references:
 *   =A1+B1, =A1-B1, =A1*B1, =A1/B1, =SUM(A1:A5)
 * This is enough to independently verify common totals/subtotals while keeping
 * the security and correctness boundary obvious.
 */
export function evaluateSimpleFormula(cell: CellRecord, model: WorkbookModel): number | null {
  const formula = cell.formula?.trim();
  if (!formula || formula === "=(shared formula)" || cell.externalFormula) return null;
  const sheet = model.sheets.find(s => s.name === cell.sheet);
  if (!sheet) return null;
  const at = new Map(sheet.cells.filter(c => c.type === "number" && typeof c.value === "number").map(c => [`${c.row},${c.col}`, c.value as number]));
  const get = (ref:string): number | null => {
    const a=parseA1(ref.replace(/\$/g,"")); if(!a) return null;
    const v=at.get(`${a.row},${a.col}`); return typeof v === "number" ? v : null;
  };
  const body=formula.slice(1).replace(/\s+/g,"");
  const sum=/^SUM\((\$?[A-Za-z]{1,3}\$?\d+:\$?[A-Za-z]{1,3}\$?\d+)\)$/i.exec(body);
  if(sum){ const r=parseRangeText(sum[1].replace(/\$/g,"")); if(!r) return null; let total=0; for(let row=r.startRow;row<=r.endRow;row++) for(let col=r.startCol;col<=r.endCol;col++){ const v=at.get(`${row},${col}`); if(typeof v!=="number") return null; total+=v; } return total; }
  const binary=/^(\$?[A-Za-z]{1,3}\$?\d+)([+\-*/])(\$?[A-Za-z]{1,3}\$?\d+)$/.exec(body);
  if(!binary) return null;
  const a=get(binary[1]), b=get(binary[3]); if(a===null||b===null) return null;
  switch(binary[2]){ case "+": return a+b; case "-": return a-b; case "*": return a*b; case "/": return b===0?null:a/b; default:return null; }
}
