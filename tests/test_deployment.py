"""Real HTTP checks against disposable data; never opens the user's data directory.
Run: .venv/bin/python -m unittest discover -s tests -v
"""
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "integration-test-token-0123456789abcdef"


class DeploymentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="dmbox-test-")
        cls.data = Path(cls.temp.name)
        (cls.data / "media").mkdir()
        (cls.data / "media" / "sample.txt").write_text("test attachment")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.env = {**os.environ, "DMBOX_DATA_DIR": str(cls.data),
                   "DMBOX_REQUIRE_AUTH": "true", "DMBOX_API_TOKEN": TOKEN}
        cls.log = tempfile.TemporaryFile(mode="w+")
        cls.process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "server.app:app", "--host", "127.0.0.1",
             "--port", str(cls.port), "--no-proxy-headers"], cwd=ROOT, env=cls.env,
            stdout=cls.log, stderr=cls.log)
        cls.client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            for _ in range(100):
                if cls.process.poll() is not None:
                    cls.log.seek(0)
                    raise RuntimeError(cls.log.read())
                try:
                    status, _, _ = cls.request("/api/health")
                    if status == 200:
                        return
                except OSError:
                    pass
                time.sleep(0.05)
            raise RuntimeError("Test server did not start")
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait()
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def request(cls, path, body=None, auth="bearer", origin=None):
        headers = {}
        if auth == "bearer":
            headers["Authorization"] = "Bearer " + TOKEN
        elif auth == "basic":
            headers["Authorization"] = "Basic " + base64.b64encode(f"dmbox:{TOKEN}".encode()).decode()
        elif auth:
            headers["Authorization"] = auth
        if origin:
            headers["Origin"] = origin
        payload = None if body is None else json.dumps(body).encode()
        if payload is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(cls.base + path, data=payload, headers=headers)
        try:
            response = cls.client.open(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.read(), response.headers

    def test_all_routes_require_auth_including_assets(self):
        for path in ["/", "/app.js", "/api/health", "/api/messages?uid=123",
                     "/media/sample.txt", "/exports/example.html"]:
            with self.subTest(path=path):
                status, _, headers = self.request(path, auth=None)
                self.assertEqual(status, 401)
                self.assertIn("Basic", headers["WWW-Authenticate"])
        for bad in ["Bearer wrong", "Basic ???", "Basic " + base64.b64encode(b"wrong:" + TOKEN.encode()).decode()]:
            self.assertEqual(self.request("/api/stats", auth=bad)[0], 401)
        self.assertEqual(self.request("/api/health?token=" + TOKEN, auth=None)[0], 401)

    def test_browser_basic_and_media(self):
        for path in ["/", "/app.js", "/style.css", "/api/stats", "/media/sample.txt"]:
            with self.subTest(path=path):
                status, _, headers = self.request(path, auth="basic")
                self.assertEqual(status, 200)
                self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.request("/media/missing.txt")[0], 404)

    def test_ingest_query_export_and_persistence(self):
        body = {"uid": "123", "mode": "incremental", "messages": [
            {"mid": "98765", "sender_id": "123", "recipient_id": "456",
             "text": "NAS integration sample", "created_at": "2026-11-07T10:00:00"}]}
        status, result, _ = self.request("/api/ingest", body, origin="chrome-extension://test")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(result)["new"], 1)
        self.assertEqual(json.loads(self.request("/api/ingest", body)[1])["dup"], 1)
        result = json.loads(self.request("/api/sync_state?uid=123")[1])
        self.assertEqual(result["count"], 1)
        messages = json.loads(self.request("/api/messages?uid=123")[1])
        self.assertEqual(messages[0]["text"], "NAS integration sample")
        self.assertTrue((self.data / "weibo_dm.db").is_file())
        status, result, _ = self.request("/api/export?uid=123", {})
        self.assertEqual(status, 200)
        export = json.loads(result)
        self.assertTrue((self.data / "exports" / export["name"]).is_file())
        path = "/exports/" + urllib.parse.quote(export["name"])
        self.assertEqual(self.request(path, auth=None)[0], 401)
        self.assertIn(b"NAS integration sample", self.request(path, auth="basic")[1])
        # A new interpreter must read the same persisted database.
        check = subprocess.run([sys.executable, "-c", "from server import db; print(db.get_conn().execute('SELECT COUNT(*) FROM messages').fetchone()[0])"],
                               cwd=ROOT, env=self.env, capture_output=True, text=True, check=True)
        self.assertEqual(check.stdout.strip(), "1")

    def test_cross_site_write_rejected(self):
        self.assertEqual(self.request("/api/contacts", {"uid": "999"},
                                      auth="basic", origin="https://other.example")[0], 403)
        self.assertEqual(self.request("/api/contacts", {"uid": "999"},
                                      auth="basic", origin=self.base)[0], 200)

    def test_invalid_deployment_fails_before_startup(self):
        for changes in [{"DMBOX_API_TOKEN": ""}, {"DMBOX_API_TOKEN": "short"},
                        {"DMBOX_DATA_DIR": str(self.data / "unmounted")}, {"DMBOX_DATA_DIR": ""}]:
            with self.subTest(changes=changes):
                result = subprocess.run([sys.executable, "-c", "from server.config import validate; validate()"],
                                        cwd=ROOT, env={**self.env, **changes}, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.data / "unmounted").exists())

    def test_default_local_mode_still_available(self):
        env = {**self.env, "DMBOX_REQUIRE_AUTH": "false", "DMBOX_API_TOKEN": ""}
        code = """import asyncio
from starlette.requests import Request
from starlette.responses import Response
from server.auth import access_guard
async def run():
    request = Request({'type':'http','method':'GET','path':'/','headers':[]})
    async def next_handler(request): return Response('ok')
    assert (await access_guard(request, next_handler)).status_code == 200
asyncio.run(run())
"""
        subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env, check=True)


if __name__ == "__main__":
    unittest.main()
