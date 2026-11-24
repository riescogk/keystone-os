"""Self-contained local web service + UI for Table Verification (standard library only).

POST /api/table-verification/run      multipart: word=<.doc/.docx>, excel=<.xlsx/.xlsm>  -> {job}
GET  /api/table-verification/status?job=ID  -> {state, message, summary}
GET  /api/table-verification/download/ID.{html|json|csv|tables.csv|cells.csv}
Uploaded files are copied to a private temp dir and only ever opened read-only.
"""
from __future__ import annotations
import json, os, tempfile, threading, uuid, traceback, shutil
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from .review import run_review
from .report import to_html, to_json, findings_csv, cells_csv, tables_csv
from .ocr import make_ocr

JOBS: dict = {}
ROOT = tempfile.mkdtemp(prefix='kstv-')
MAX_BYTES = 400 * 1024 * 1024
OCR = make_ocr(os.path.join(ROOT, 'ocr-cache'))

PAGE = r"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Table Verification</title><style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2433;--mut:#5b6577;--line:#e2e6ee;--acc:#1f3a8a}
@media(prefers-color-scheme:dark){:root{--bg:#10141c;--card:#171c27;--ink:#e8ecf4;--mut:#9aa4b8;--line:#2a3142;--acc:#8fb0ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 20px}h1{font-size:24px;margin:0 0 4px}.sub{color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:18px 0}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:700px){.row{grid-template-columns:1fr}}
label{display:block;font-weight:600;margin-bottom:6px}input[type=file]{width:100%;padding:10px;border:1px dashed var(--line);border-radius:8px;background:transparent;color:var(--ink)}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer}button:disabled{opacity:.5;cursor:default}
@media(prefers-color-scheme:dark){button{color:#0b1020}}
a.dl{display:inline-block;margin:4px 10px 0 0;color:var(--acc);font-weight:600}iframe{width:100%;height:78vh;border:1px solid var(--line);border-radius:12px;background:#fff}
#msg{margin-left:12px;color:var(--mut)}.err{color:#b42318;font-weight:600}</style>
<main><h1>Table Verification</h1><div class="sub">Compares the tables in a Word appraisal report with the tables in its Excel workbook. Narrative text is not reviewed. Your files are not modified.</div>
<div class="card"><div class="row"><div><label for="w">1. Word report (.doc / .docx)</label><input id="w" type="file" accept=".doc,.docx"></div>
<div><label for="x">2. Excel workbook (.xlsm / .xlsx)</label><input id="x" type="file" accept=".xlsm,.xlsx"></div></div>
<p><button id="go">3. Run Table Verification</button><span id="msg"></span></p></div>
<div id="out"></div></main>
<script>
const $=id=>document.getElementById(id);
$('go').onclick=async()=>{
 const w=$('w').files[0],x=$('x').files[0]; if(!w||!x){$('msg').innerHTML='<span class="err">Choose both files.</span>';return}
 $('go').disabled=true;$('out').innerHTML='';$('msg').textContent='Uploading…';
 const fd=new FormData();fd.append('word',w);fd.append('excel',x);
 let r=await fetch('/api/table-verification/run',{method:'POST',body:fd});let j=await r.json();
 if(!r.ok){$('msg').innerHTML='<span class="err">'+(j.error||'Failed')+'</span>';$('go').disabled=false;return}
 const poll=async()=>{let s=await (await fetch('/api/table-verification/status?job='+j.job)).json();
  if(s.state==='running'){$('msg').textContent=s.message;setTimeout(poll,800)}
  else if(s.state==='error'){$('msg').innerHTML='<span class="err">'+s.message+'</span>';$('go').disabled=false}
  else{$('msg').textContent='Done in '+s.summary.elapsed_seconds+' s';$('go').disabled=false;const b='/api/table-verification/download/'+j.job;
   $('out').innerHTML='<div class="card"><b>Download:</b> <a class="dl" href="'+b+'.html" download>Report (HTML)</a><a class="dl" href="'+b+'.json" download>Full data (JSON)</a><a class="dl" href="'+b+'.csv" download>Discrepancies (CSV)</a><a class="dl" href="'+b+'.tables.csv" download>Table coverage (CSV)</a><a class="dl" href="'+b+'.cells.csv" download>Every cell (CSV)</a></div><iframe src="'+b+'.html?inline=1"></iframe>'}};
 poll();};
</script></html>"""


def _job_run(job, word, excel):
    def prog(m): JOBS[job]['message'] = m
    try:
        res = run_review(word, excel, ocr=OCR, progress=prog)
        d = os.path.join(ROOT, job)
        files = {'html': to_html(res), 'json': to_json(res), 'csv': findings_csv(res), 'tables.csv': tables_csv(res), 'cells.csv': cells_csv(res)}
        for ext, body in files.items(): open(os.path.join(d, f'report.{ext}'), 'w', encoding='utf-8-sig' if 'csv' in ext else 'utf-8', newline='').write(body)
        JOBS[job].update(state='done', summary=res['summary'], message='Done')
    except Exception as e:
        JOBS[job].update(state='error', message=f'{type(e).__name__}: {e}')
        traceback.print_exc()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, code, body, ctype='application/json', extra=None):
        b = body if isinstance(body, bytes) else body.encode('utf-8')
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b)))
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ('/', '/table-verification'): return self._send(200, PAGE, 'text/html; charset=utf-8')
        if u.path == '/api/table-verification/status':
            j = JOBS.get(parse_qs(u.query).get('job', [''])[0])
            return self._send(200 if j else 404, json.dumps(j or {'error': 'unknown job'}))
        if u.path.startswith('/api/table-verification/download/'):
            name = u.path.rsplit('/', 1)[1]; job, _, ext = name.partition('.')
            if job not in JOBS or ext not in ('html', 'json', 'csv', 'tables.csv', 'cells.csv'): return self._send(404, '{"error":"not found"}')
            p = os.path.join(ROOT, job, f'report.{ext}')
            if not os.path.exists(p): return self._send(404, '{"error":"not ready"}')
            ctype = {'html': 'text/html; charset=utf-8', 'json': 'application/json'}.get(ext, 'text/csv; charset=utf-8')
            disp = {} if 'inline=1' in u.query else {'Content-Disposition': f'attachment; filename="table-verification.{ext}"'}
            return self._send(200, open(p, 'rb').read(), ctype, disp)
        self._send(404, '{"error":"not found"}')

    def do_POST(self):
        if urlparse(self.path).path != '/api/table-verification/run': return self._send(404, '{"error":"not found"}')
        n = int(self.headers.get('Content-Length', 0))
        if n <= 0 or n > MAX_BYTES: return self._send(413, json.dumps({'error': 'Upload too large or empty.'}))
        raw = self.rfile.read(n)
        msg = BytesParser(policy=default).parsebytes(b'Content-Type: ' + self.headers['Content-Type'].encode() + b'\r\n\r\n' + raw)
        parts = {p.get_param('name', header='content-disposition'): p for p in msg.iter_parts()}
        if 'word' not in parts or 'excel' not in parts: return self._send(400, json.dumps({'error': 'Both a Word file and an Excel file are required.'}))
        wname = os.path.basename(parts['word'].get_filename() or 'report.doc'); xname = os.path.basename(parts['excel'].get_filename() or 'book.xlsm')
        if not wname.lower().endswith(('.doc', '.docx')) or not xname.lower().endswith(('.xlsx', '.xlsm')):
            return self._send(400, json.dumps({'error': 'Word must be .doc/.docx and Excel must be .xlsx/.xlsm.'}))
        job = uuid.uuid4().hex[:12]; d = os.path.join(ROOT, job); os.makedirs(d)
        wp, xp = os.path.join(d, 'in-' + wname), os.path.join(d, 'in-' + xname)
        open(wp, 'wb').write(parts['word'].get_payload(decode=True)); open(xp, 'wb').write(parts['excel'].get_payload(decode=True))
        JOBS[job] = dict(state='running', message='Starting…')
        threading.Thread(target=_job_run, args=(job, wp, xp), daemon=True).start()
        self._send(200, json.dumps({'job': job}))


def serve(host='127.0.0.1', port=8765):
    print(f'Table Verification running at http://{host}:{port}/  (OCR for bitmap tables: {"on" if OCR else "off"})')
    try: ThreadingHTTPServer((host, port), H).serve_forever()
    except KeyboardInterrupt: pass
    finally: shutil.rmtree(ROOT, ignore_errors=True)
