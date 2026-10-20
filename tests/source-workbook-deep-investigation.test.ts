import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { linkReportToWorkbook } from "@/lib/review/source/linking";
import { selectSourceModelCandidates } from "@/lib/review/source/modelInvestigation";
import { evaluateSimpleFormula } from "@/lib/review/source/simpleFormula";
import type { WorkbookModel, CellRecord } from "@/lib/review/source/workbookModel";
import type { PageText } from "@/lib/review/types";

const n = (ref:string,row:number,col:number,value:number): CellRecord => ({ sheet:"Valuation", ref,row,col,type:"number",value,formula:null,externalFormula:false,uncached:false,numberFormat:"$#,##0" });
const s = (ref:string,row:number,col:number,value:string): CellRecord => ({ sheet:"Valuation", ref,row,col,type:"string",value,formula:null,externalFormula:false,uncached:false,numberFormat:null });
function model(cells: CellRecord[]): WorkbookModel { return { format:"xlsx", containsMacros:false, externalLinkCount:0, definedNames:[], sheets:[{ name:"Valuation", state:"visible", cells, mergedRanges:[], tables:[] }] }; }
const pages = (...text:string[]): PageText[] => text.map((t,i)=>({pageNumber:i+1,text:t}));

describe("Milestone 14 v2 deep source investigation", () => {
  it("links a multi-cell defined range only when the report exposes the same ordered figure count", () => {
    const m=model([n("B2",2,2,1000000),n("C2",2,3,1100000),n("D2",2,4,1200000)]);
    m.definedNames.push({name:"N1ValueRange",scopeSheet:null,target:"Valuation!$B$2:$D$2",resolved:{sheet:"Valuation",range:{startRow:2,startCol:2,endRow:2,endCol:4}}});
    const result=linkReportToWorkbook(pages("N1ValueRange: $1,000,000  $1,100,000  $1,200,000"),m);
    assert.equal(result.links.length,3);
    assert.ok(result.links.every(l=>l.strategy==="defined_range"));
    assert.equal(result.links[0].sourceRange,"B2:D2");
  });

  it("refuses a multi-cell defined range when report/workbook cardinality differs", () => {
    const m=model([n("B2",2,2,1000000),n("C2",2,3,1100000)]);
    m.definedNames.push({name:"N1ValueRange",scopeSheet:null,target:"Valuation!$B$2:$C$2",resolved:{sheet:"Valuation",range:{startRow:2,startCol:2,endRow:2,endCol:3}}});
    const result=linkReportToWorkbook(pages("N1ValueRange: $1,000,000"),m);
    assert.equal(result.links.length,0);
    assert.ok(result.ambiguous>=1);
  });

  it("links a unique contextual row containing multiple ordered figures", () => {
    const m=model([s("A5",5,1,"Historical Revenue"),n("B5",5,2,1000000),n("C5",5,3,1100000)]);
    const result=linkReportToWorkbook(pages("Historical Revenue: $1,000,000  $1,100,000"),m);
    assert.equal(result.links.length,2);
    assert.ok(result.links.every(l=>l.strategy==="context_label"));
  });

  it("independently verifies a bounded simple subtotal formula", () => {
    const a=n("B7",7,2,1425000), b=n("B8",8,2,500000);
    const total={...n("B9",9,2,999999), formula:"=B7-B8"};
    const m=model([a,b,total]);
    assert.equal(evaluateSimpleFormula(total,m),925000);
  });

  it("selects only explicit named/table context for bounded model assistance", () => {
    const m=model([n("B2",2,2,1000000)]);
    m.definedNames.push({name:"N1CompCapRates",scopeSheet:null,target:"Valuation!$B$2",resolved:{sheet:"Valuation",range:{startRow:2,startCol:2,endRow:2,endCol:2}}});
    const selected=selectSourceModelCandidates(pages("The report discusses N1CompCapRates and related capitalization information."),m);
    assert.equal(selected.length,1);
    assert.equal(selected[0].key,"N1CompCapRates");
    assert.equal(selected[0].range,"B2");
  });
it("links Low / High / Average statistics inside an explicitly embedded .doc named range", () => {
  const low = {
    ...n("J163", 163, 10, 0.0477205322580645),
    numberFormat: "0.00%",
  };

  const high = {
    ...n("J164", 164, 10, 0.0580732102834541),
    numberFormat: "0.00%",
  };

  const average = {
    ...n("J165", 165, 10, 0.05221314917593271),
    numberFormat: "0.00%",
  };

  const m = model([
    s("E163", 163, 5, "Low"),
    low,
    s("E164", 164, 5, "High"),
    high,
    s("E165", 165, 5, "Average"),
    average,
  ]);

  m.definedNames.push({
    name: "N1CompCapRates",
    scopeSheet: null,
    target: "Valuation!$E$151:$J$166",
    resolved: {
      sheet: "Valuation",
      range: {
        startRow: 151,
        startCol: 5,
        endRow: 166,
        endCol: 10,
      },
    },
  });

  const result = linkReportToWorkbook(
    pages(
  "Operating expenses ranged from 31.25% to 42.50% with an average of 36.80%. The sales above indicate capitalization rates from 4.77% to 5.81% with an average of 5.22%. The comparable sales data supports the analysis."
),
    m,
    [
      {
        sheet: "Valuation",
        definedName: "N1CompCapRates",
      },
    ]
  );

  assert.equal(result.links.length, 3);

  assert.deepEqual(
    result.links.map((link) => link.label),
    ["Low", "High", "Average"]
  );

  assert.deepEqual(
    result.links.map((link) => link.cell.ref),
    ["J163", "J164", "J165"]
  );

  assert.deepEqual(
    result.links.map((link) => link.reportFigure.raw),
    ["4.77%", "5.81%", "5.22%"]
  );

  assert.ok(
    result.links.every(
      (link) =>
        link.strategy === "defined_range" &&
        link.definedName === "N1CompCapRates" &&
        link.sourceRange === "E151:J166"
    )
  );
});

});
