# Keystone Table Verification (engine `kstv`) - v1.1

Compares **tables in a Word report** (Word = the document being audited) with **tables in its Excel workbook** (Excel = the master).
Nothing else: no narrative, grammar or wording review. No PDF conversion, no LibreOffice/Word/Excel automation. The original files are only ever opened read-only.

## Install and run on Windows (PowerShell)

Requires Python 3.10+ (check with `py --version`; install from python.org and tick "Add python.exe to PATH" if needed).

```powershell
# 1) unzip keystone-table-verification-v1.1.zip, then open PowerShell in the unzipped folder
cd .\tools\table-verification

# 2) one-time setup: private environment + packages
py -m venv .venv
.\.venv\Scripts\Activate.ps1          # if blocked:  Set-ExecutionPolicy -Scope Process Bypass
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

# 3) run the self-checks (unit + synthetic tests, ~2 seconds; no real files needed)
python -m pytest -q tests

# 4) review one report/workbook pair  ->  HTML report + JSON + 3 CSV files in .\out
python -m kstv review "C:\path\25124-TonganoxieVacantLand.doc" "C:\path\25124-TonganoxieVacantLand.xlsm" --out .\out
start .\out\25124-TonganoxieVacantLand.table-verification.html

# 5) or use the local web page (Upload -> Run -> Results -> Download)
python -m kstv serve                   # then open http://127.0.0.1:8765/   (Ctrl+C to stop)

# 6) tests against YOUR real files (about 4 minutes) - point at the folder holding the .doc/.xlsm files
$env:KSTV_SAMPLES = "C:\path\to\your\samples"
python -m pytest -q tests

# 7) regenerate the consolidated table for all reports + both altered-workbook controls
python scripts\run_samples.py "C:\path\to\your\samples" .\out\results
```
`python -m kstv review` exits with code 1 when discrepancies are found (useful in scripts), 0 otherwise.
Optional: install the Tesseract program and `python -m pip install pytesseract`, then add `--ocr` to also read the text of bitmap table screenshots. Without it those screenshots are listed as **Unverified**, never skipped.

## What each table/cell can be

| Word table status | Meaning |
|---|---|
| **FULL** | Every Word cell was located in Excel and compared exactly (or only differs by formatting/rounding). |
| **PARTIAL** | Some cells could not be located in Excel (`cells not located`) and/or some text is visibly truncated in Word (`truncated text`). Counts are shown per table. |
| **UNVERIFIED** | No trustworthy Excel counterpart (or a bitmap that cannot be read). Shown with evidence; its values are never used and it is never counted as passed. |

Cell outcomes: `match` / `format_only` (same value, different formatting or rounding) / `clipped` (Word shows only the leading part of the Excel text; see below) / `mismatch` (a real discrepancy) / `not located`.

## How a table is found (labels first, numbers last)
1. **Word side.** The `.doc` binary is parsed directly, so pictures come out in true document order; tables pasted from Excel are vector pictures (EMF) whose drawing instructions hold every cell's exact text and position. Native `.docx`/`.doc` tables are read with their cell structure. Bitmaps are classified (table screenshot / photo-aerial-map / signature / chart-plan / needs a visual check) from pixel statistics - no OCR required.
2. **Excel side.** Every cell with its cached value, **displayed** text (number formats), wrap flag, merged ranges, hidden rows/columns.
3. **Locate by titles, headings and row labels.** Numbers are deliberately a very weak signal (they are what is being audited): a table whose every number is wrong is still found by its labels, and the wrong numbers are reported. Year headings count as labels. Only after the region is fixed are values allowed to help place an individual row inside it.
4. **Look-alike ranges** (As Is / As Complete, repeated tables, side-by-side or stacked ranges with the same labels, same labels on another sheet) are detected from the LABELS alone. The range is chosen by the Word title and surrounding text; only if that is identical is it chosen by fewest value mismatches, and then the report says **AMBIGUOUS SOURCE** and lists the other range(s) with their mismatch counts.
5. **Compare** every aligned cell using Excel's displayed text and Word's displayed precision.

## Cell accounting (nothing silently disappears)
Every table reports `text records extracted -> logical cells`, because Word pictures draw one wrapped line / one `$` / one bold run as a separate text record. Example (Tonganoxie): **616 text records -> 593 logical cells** = 23 wrapped lines folded into multi-line cells (each fold is only made when the aligned Excel region contains exactly that text). Each logical cell is in exactly one outcome category and the sum is checked.

## Truncated (clipped) text
Excel clips text at the cell edge (or the row height for wrapped cells). A shortened Word text is **never** called an exact match. It is reported as `clipped` with evidence from the picture geometry: `confirmed` (the next word cannot fit before the next cell / the text reaches the cell edge), `wrapped` (remaining wrapped lines hidden by row height), `consistent`, or `unconfirmed` (there seemed to be room: look at it). If other text of the same length fits in that column, it is reported as a **mismatch**. Tables containing truncated cells are `PARTIAL (truncated text)` because the hidden remainder cannot be checked in Word. They are listed in report section 1c.

## Word location - what is and is not possible
Word files store **no page layout**; exact page numbers cannot be read without rendering the document (PDF conversion is excluded). What is available, and shown:
- **Page bracket** from the report's own saved table of contents (PAGEREF fields tied to heading bookmarks) + manual page breaks: e.g. "between pages 19 and 24". It is a bracket, not an exact page, and can be stale if the contents list was not refreshed before saving. If the file has no usable table of contents it says "not available" - a page is never invented.
- **Table number** in document order, **graphic number** (position among all inline pictures), the text immediately before/after the table (use Ctrl+F), row label and column header.
- **Excel**: worksheet name and exact cell address (e.g. `Rent Roll!BH87`).

## Known limitations
- The narrative layout table wrapping each report's body text is not compared (long prose cells, not tabular data); short facts inside it (e.g. "Year Built") are not checked.
- Bitmap table screenshots (third-party market data in the reports tested) are listed Unverified unless OCR is installed; OCR can misread. Bitmaps that look like charts but could be tables are flagged "check visually".
- Excel formulas are not recalculated; the last saved values are used.
- Tables built from non-contiguous Excel areas or with derived values absent from the workbook come out PARTIAL/UNVERIFIED, never "passed".
- A truncated cell's hidden remainder, and a table pasted from one of two identical look-alike ranges, cannot be fully resolved from the Word file alone; both are reported, not guessed.

## Note on older files in this folder
The earlier prototype scripts (`smart_web.py`, `table_review*.py`, `extract_*.py`, etc.) are left untouched for reference and are **not used** by `kstv`. Everything above runs from the `kstv` package only.
