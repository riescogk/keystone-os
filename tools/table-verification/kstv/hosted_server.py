"""Authenticated single-instance web server for Keystone Table Verification.

The original kstv.server remains available for local development. Production exposes
only /health, /api/table-verification/run, /status, and /download/<job>.<format>.
Every job endpoint requires a short-lived HMAC token minted by Keystone after
Supabase authentication. Jobs are bound to the token's Supabase subject.

Architecture note: single process/instance; job state is in memory and outputs are
stored in short-lived private temporary directories. Scale=1 until a persistent
queue/storage is implemented.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import tempfile
import threading
import time
import traceback
import uuid
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .review import run_review
from .report import cells_csv, findings_csv, tables_csv, to_html, to_json

SECRET = os.environ.get('KSTV_SHARED_SECRET', '')
ORIGINS = {v.strip().rstrip('/') for v in os.environ.get('KSTV_ALLOWED_ORIGINS', '').split(',') if v.strip()}
MAX_BYTES = min(int(os.environ.get('KSTV_MAX_UPLOAD_BYTES', str(85 * 1024 * 1024))), 100 * 1024 * 1024)
JOB_TTL_SECONDS = 60 * 60
MAX_ACTIVE = 1
ROOT = Path(tempfile.mkdtemp(prefix='kstv-hosted-'))
JOBS: dict[str, dict] = {}
LOCK = threading.RLock()
FORMATS = ('html', 'json', 'csv', 'tables.csv', 'cells.csv')
ERROR_MESSAGE = 'Verification failed. Please contact the administrator if this continues.'


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def verify_ticket(header: str | None, now: float | None = None) -> str | None:
    """Returns authenticated user ID, or None. Constant-time signature checking."""
    if not SECRET or len(SECRET) < 32 or not header or not header.startswith('Bearer '):
        return None
    token = header[7:]
    if len(token) > 4096 or token.count('.') != 1:
        return None
    data, signature = token.split('.', 1)
    expected = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), data.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    if not hmac.compare_digest(expected, signature):
        return None
    try:
        payload = json.loads(_unb64(data))
        timestamp = time.time() if now is None else now
        if payload.get('v') != 1 or payload.get('iss') != 'keystone' or payload.get('aud') != 'table-verification':
            return None
        if not isinstance(payload.get('sub'), str) or not re.fullmatch(r'[a-fA-F0-9-]{36}', payload['sub']):
            return None
        if not isinstance(payload.get('exp'), (int, float)) or not timestamp < payload['exp'] <= timestamp + 7200:
            return None
        return payload['sub']
    except (ValueError, TypeError, OverflowError):
        return None


def _safe_name(value: str | None, fallback: str) -> str:
    value = (value or fallback).replace('\\', '/')
    name = value.rsplit('/', 1)[-1]
    # Keep enough of original filename for the report; no slashes or controls.
    name = re.sub(r'[^\w. ()-]', '_', name, flags=re.UNICODE).strip(' .')[:120]
    return name or fallback


def _cleanup() -> None:
    now = time.monotonic()
    with LOCK:
        for ident, entry in list(JOBS.items()):
            if entry['state'] != 'running' and now - entry.get('finished_at', entry['created_at']) > JOB_TTL_SECONDS:
                JOBS.pop(ident, None)
                shutil.rmtree(ROOT / ident, ignore_errors=True)


def _periodic_cleanup() -> None:
    while True:
        time.sleep(60)
        _cleanup()


def _process(job: str, word: Path, excel: Path) -> None:
    def progress(message: str) -> None:
        with LOCK:
            if job in JOBS:
                JOBS[job]['message'] = str(message)[:250]
    try:
        result = run_review(str(word), str(excel), ocr=None, progress=progress)
        folder = ROOT / job
        contents = {
            'html': to_html(result), 'json': to_json(result),
            'csv': findings_csv(result), 'tables.csv': tables_csv(result),
            'cells.csv': cells_csv(result),
        }
        for extension, body in contents.items():
            (folder / ('report.' + extension)).write_text(body, encoding='utf-8-sig' if 'csv' in extension else 'utf-8')
        with LOCK:
            JOBS[job].update(state='done', message='Done', summary=result['summary'], finished_at=time.monotonic())
    except Exception:
        traceback.print_exc()
        with LOCK:
            if job in JOBS:
                JOBS[job].update(state='error', message=ERROR_MESSAGE, finished_at=time.monotonic())
    finally:
        # The original client documents should not remain on disk after processing.
        word.unlink(missing_ok=True)
        excel.unlink(missing_ok=True)


class Handler(BaseHTTPRequestHandler):
    server_version = 'KSTV/1.1'

    def log_message(self, fmt, *args):
        # Never log signed tokens, filenames, or other client-provided data.
        pass

    def _origin(self) -> str | None:
        return self.headers.get('Origin', '').rstrip('/') or None

    def _headers(self) -> dict[str, str]:
        origin = self._origin()
        h = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin'}
        if origin in ORIGINS:
            h.update({'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600'})
        return h

    def _send(self, code: int, body: bytes | str, ctype: str = 'application/json', extras: dict | None = None):
        data = body if isinstance(body, bytes) else body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        for key, value in {**self._headers(), **(extras or {})}.items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _error(self, code: int, message: str):
        self._send(code, json.dumps({'error': message}))

    def _auth(self) -> str | None:
        if self._origin() and self._origin() not in ORIGINS:
            self._error(403, 'Origin not allowed.')
            return None
        subject = verify_ticket(self.headers.get('Authorization'))
        if not subject:
            self._error(401, 'Authentication required or session expired.')
        return subject

    def do_OPTIONS(self):
        if self._origin() not in ORIGINS:
            return self._error(403, 'Origin not allowed.')
        self._send(204, b'')

    def do_GET(self):
        path = urlparse(self.path)
        if path.path == '/health':
            return self._send(200, '{"ok":true}')
        subject = self._auth()
        if not subject:
            return
        _cleanup()
        if path.path == '/api/table-verification/status':
            job_id = parse_qs(path.query).get('job', [''])[0]
            with LOCK:
                entry = JOBS.get(job_id)
                if not entry or entry['owner'] != subject:
                    return self._error(404, 'Unknown job.')
                status = {key: value for key, value in entry.items() if key not in ('owner', 'created_at', 'finished_at')}
            return self._send(200, json.dumps(status))
        prefix = '/api/table-verification/download/'
        if path.path.startswith(prefix):
            tail = path.path[len(prefix):]
            job_id, sep, ext = tail.partition('.')
            if not sep or ext not in FORMATS or not re.fullmatch('[0-9a-f]{32}', job_id):
                return self._error(404, 'Not found.')
            with LOCK:
                entry = JOBS.get(job_id)
                if not entry or entry['owner'] != subject or entry['state'] != 'done':
                    return self._error(404, 'Not found.')
            report_path = ROOT / job_id / ('report.' + ext)
            if not report_path.is_file():
                return self._error(404, 'Report unavailable.')
            ctype = 'text/html; charset=utf-8' if ext == 'html' else 'application/json' if ext == 'json' else 'text/csv; charset=utf-8'
            return self._send(200, report_path.read_bytes(), ctype,
                              {'Content-Disposition': f'attachment; filename="table-verification.{ext}"'})
        self._error(404, 'Not found.')

    def do_POST(self):
        if urlparse(self.path).path != '/api/table-verification/run':
            return self._error(404, 'Not found.')
        subject = self._auth()
        if not subject:
            return
        _cleanup()
        with LOCK:
            if sum(1 for entry in JOBS.values() if entry['state'] == 'running') >= MAX_ACTIVE:
                return self._error(429, 'Verification server busy. Please try again shortly.')
            if any(entry['owner'] == subject and entry['state'] == 'running' for entry in JOBS.values()):
                return self._error(429, 'You already have a verification running.')
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self._error(400, 'Invalid Content-Length.')
        if not 0 < length <= MAX_BYTES:
            return self._error(413, 'Upload is empty or exceeds size limit.')
        if not self.headers.get('Content-Type', '').lower().startswith('multipart/form-data;'):
            return self._error(400, 'Multipart upload required.')
        # Content-Length is enforced before reading request body. The parser uses memory;
        # the single-instance backend needs sufficient RAM for large .doc files.
        try:
            raw = self.rfile.read(length)
            msg = BytesParser(policy=default).parsebytes(
                b'Content-Type: ' + self.headers['Content-Type'].encode('ascii') + b'\r\n\r\n' + raw)
            parts = {p.get_param('name', header='content-disposition'): p for p in msg.iter_parts()}
            if 'word' not in parts or 'excel' not in parts:
                return self._error(400, 'Both Word and Excel files are required.')
            wn = _safe_name(parts['word'].get_filename(), 'report.doc')
            xn = _safe_name(parts['excel'].get_filename(), 'book.xlsm')
            if not wn.lower().endswith(('.doc', '.docx')) or not xn.lower().endswith(('.xlsm', '.xlsx')):
                return self._error(400, 'Unsupported file extensions.')
            wb = parts['word'].get_payload(decode=True)
            xb = parts['excel'].get_payload(decode=True)
            if not wb or not xb or len(wb) + len(xb) > MAX_BYTES:
                return self._error(413, 'Upload files are empty or exceed size limit.')
            # Reject obviously incorrectly labeled inputs. Older Word .doc is OLE; .docx/Excel are ZIPs.
            magic_zip = b'PK\x03\x04'
            magic_ole = bytes.fromhex('d0cf11e0a1b11ae1')
            if not (wb.startswith(magic_zip if wn.lower().endswith('.docx') else magic_ole) and xb.startswith(magic_zip)):
                return self._error(400, 'Files do not match their Word/Excel formats.')
        except Exception:
            return self._error(400, 'Upload could not be parsed.')
        with LOCK:
            # Re-check after upload parsing, avoiding a concurrent start flood.
            if sum(1 for entry in JOBS.values() if entry['state'] == 'running') >= MAX_ACTIVE:
                return self._error(429, 'Verification server busy. Please try again shortly.')
            job = uuid.uuid4().hex
            folder = ROOT / job
            folder.mkdir(mode=0o700)
            word, excel = folder / ('in-' + wn), folder / ('in-' + xn)
            word.write_bytes(wb)
            excel.write_bytes(xb)
            JOBS[job] = dict(state='running', owner=subject, message='Starting...', created_at=time.monotonic())
        threading.Thread(target=_process, args=(job, word, excel), daemon=True).start()
        self._send(200, json.dumps({'job': job}))


def serve(host: str = '0.0.0.0', port: int = 10000):
    if len(SECRET) < 32:
        raise RuntimeError('KSTV_SHARED_SECRET must be set to a strong secret (32+ characters).')
    if not ORIGINS or any(not o.startswith(('http://localhost:', 'https://')) for o in ORIGINS):
        raise RuntimeError('KSTV_ALLOWED_ORIGINS must list allowed HTTPS website origins.')
    threading.Thread(target=_periodic_cleanup, daemon=True).start()
    print(f'Keystone Table Verification protected backend running on port {port}', flush=True)
    try:
        ThreadingHTTPServer((host, port), Handler).serve_forever(poll_interval=0.3)
    finally:
        shutil.rmtree(ROOT, ignore_errors=True)


if __name__ == '__main__':
    serve(port=int(os.environ.get('PORT', '10000')))
