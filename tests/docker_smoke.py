"""Exercise Compose using an existing dmbox:local-test image and disposable data.
Run after building: .venv/bin/python tests/docker_smoke.py
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "docker-smoke-test-only-0123456789abcdef"
client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

with tempfile.TemporaryDirectory(prefix="dmbox-docker-") as temp:
    data = Path(temp) / "data"
    data.mkdir()
    # Disposable test files only; real NAS deployments should use user-specific permissions.
    data.chmod(0o777)
    override = Path(temp) / "override.json"
    override.write_text(json.dumps({"services": {"dmbox": {"image": "dmbox:local-test",
        "healthcheck": {"interval": "1s", "start_period": "1s"}}}}))
    env = {**os.environ, "DMBOX_API_TOKEN": TOKEN, "DMBOX_HOST_DATA_DIR": str(data),
           "DMBOX_BIND_IP": "127.0.0.1", "DMBOX_PORT": "0", "DMBOX_UID": "10001", "DMBOX_GID": "10001"}
    command = ["docker", "compose", "-p", "dmbox-test-" + uuid.uuid4().hex[:8],
               "-f", str(ROOT / "compose.yaml"), "-f", str(override)]

    def compose(*args):
        return subprocess.check_output([*command, *args], env=env, text=True, stderr=subprocess.STDOUT).strip()

    def ready():
        endpoint = "http://" + compose("port", "dmbox", "8765")
        for _ in range(100):
            container = compose("ps", "-q", "dmbox")
            if container:
                status = subprocess.check_output(["docker", "inspect", "--format", "{{.State.Health.Status}}", container], text=True).strip()
                if status == "healthy":
                    return endpoint
            time.sleep(0.1)
        raise RuntimeError("Container not healthy: " + compose("logs", "--tail=30", "dmbox"))

    def request(base, path, body=None, auth=True):
        headers = {"Authorization": "Bearer " + TOKEN} if auth else {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        try:
            response = client.open(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.read()

    try:
        compose("up", "-d", "--no-build")
        base = ready()
        assert request(base, "/", auth=False)[0] == 401
        status, body = request(base, "/api/ingest", {"uid": "123", "mode": "incremental",
            "messages": [{"mid": "12345", "sender_id": "123", "text": "persistent Docker sample"}]})
        assert status == 200 and json.loads(body)["new"] == 1
        compose("up", "-d", "--force-recreate", "--no-build")
        base = ready()
        status, body = request(base, "/api/sync_state?uid=123")
        assert status == 200 and json.loads(body)["count"] == 1
        container = compose("ps", "-q", "dmbox")
        uid = subprocess.check_output(["docker", "exec", container, "id", "-u"], text=True).strip()
        assert uid == "10001"
        assert (data / "weibo_dm.db").is_file()
        print("Compose: healthy, non-root, authenticated, NAS-directory storage and data preserved after container recreation.")
    except BaseException:
        print(compose("logs", "--tail=30", "dmbox"))
        raise
    finally:
        compose("down", "--timeout", "5")
