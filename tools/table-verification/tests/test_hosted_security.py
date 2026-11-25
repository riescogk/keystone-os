"""Isolated tests for the production HTTP boundary; no client files needed."""
import base64
import hashlib
import hmac
import http.client
import json
import os
import threading
import time
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault('KSTV_SHARED_SECRET', 'unit-test-secret-CHANGE-ME-012345678901234567890')
os.environ.setdefault('KSTV_ALLOWED_ORIGINS', 'https://keystone-os-alpha.vercel.app')

from kstv import hosted_server as hs


def _token(owner, exp=None):
    claims = {'v': 1, 'iss': 'keystone', 'aud': 'table-verification',
              'sub': owner, 'exp': exp if exp is not None else int(time.time()) + 3600,
              'nonce': uuid.uuid4().hex}
    data = base64.urlsafe_b64encode(json.dumps(claims, separators=(',', ':')).encode()).decode().rstrip('=')
    sig = base64.urlsafe_b64encode(hmac.new(hs.SECRET.encode(), data.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return data + '.' + sig


def _request(server, method, path, ticket=None, origin=None, body=None, headers=None):
    conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
    custom = dict(headers or {})
    if ticket: custom['Authorization'] = 'Bearer ' + ticket
    if origin: custom['Origin'] = origin
    conn.request(method, path, body=body, headers=custom)
    response = conn.getresponse()
    result = (response.status, dict(response.getheaders()), response.read())
    conn.close()
    return result


def test_ticket_signature_expiry_and_scope():
    owner = str(uuid.uuid4())
    token = _token(owner)
    assert hs.verify_ticket('Bearer ' + token) == owner
    assert hs.verify_ticket('Bearer ' + token[:-2] + 'AA') is None
    assert hs.verify_ticket('Bearer ' + _token(owner, time.time() - 100)) is None
    assert hs.verify_ticket('Bearer ' + token, now=time.time() + 7201) is None
    assert hs.verify_ticket(None) is None


def test_cors_and_job_ownership(tmp_path):
    server = ThreadingHTTPServer(('127.0.0.1', 0), hs.Handler)
    runner = threading.Thread(target=server.serve_forever, daemon=True)
    runner.start()
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    ident = uuid.uuid4().hex
    hs.JOBS[ident] = {'state': 'done', 'owner': first, 'message': 'Done', 'summary': {}, 'created_at': time.monotonic()}
    folder = hs.ROOT / ident
    folder.mkdir(exist_ok=True)
    (folder / 'report.html').write_text('<p>report</p>')
    try:
        assert _request(server, 'GET', '/health')[0] == 200
        assert _request(server, 'GET', '/api/table-verification/status?job=' + ident)[0] == 401
        assert _request(server, 'GET', '/api/table-verification/status?job=' + ident,
                        _token(first), 'https://evil.example')[0] == 403
        assert _request(server, 'GET', '/api/table-verification/status?job=' + ident,
                        _token(second))[0] == 404
        code, headers, data = _request(server, 'GET', '/api/table-verification/status?job=' + ident,
                                      _token(first), 'https://keystone-os-alpha.vercel.app')
        assert code == 200 and json.loads(data)['state'] == 'done'
        assert headers['Access-Control-Allow-Origin'] == 'https://keystone-os-alpha.vercel.app'
        assert _request(server, 'GET', f'/api/table-verification/download/{ident}.html', _token(second))[0] == 404
        assert _request(server, 'GET', f'/api/table-verification/download/{ident}.html', _token(first))[0] == 200
        assert _request(server, 'OPTIONS', '/api/table-verification/run',
                        origin='https://keystone-os-alpha.vercel.app')[0] == 204
        assert _request(server, 'OPTIONS', '/api/table-verification/run',
                        origin='https://evil.example')[0] == 403
    finally:
        server.shutdown()
        server.server_close()
        hs.JOBS.pop(ident, None)
        import shutil
        shutil.rmtree(folder, ignore_errors=True)
