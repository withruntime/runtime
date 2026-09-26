"""Volume backups against a stub API: the paths, bodies and waits the SDK
sends for backup, backup policy, listing, deleting and restoring. The routes
are tested in packages/cloud (volumes-backups-api) and the lifecycle in
packages/db (cloud-durable)."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from withruntime import AsyncRuntime, Runtime

VOLUME = "8a1f9c2e-0d1b-4c3a-9e8f-7a6b5c4d3e2f"
BACKUP = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f"


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def _reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _route(self):
        url = urlsplit(self.path)
        length = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(length)) if length else None
        Stub.seen.append((self.command, url.path, url.query, body, self.headers.get("prefer")))
        path = url.path
        if path == f"/v1/volumes/{VOLUME}:backup":
            return self._reply(201, {"id": BACKUP, "kind": "volume-backup", "state": "ready", "volumeId": VOLUME})
        if path == f"/v1/volumes/{VOLUME}:backup-policy":
            return self._reply(200, {"id": VOLUME, "backups": {"daily": body.get("daily", True),
                                                               "retentionDays": body.get("retentionDays", 7)}})
        if path == "/v1/volume-backups":
            return self._reply(200, {"data": [{"id": BACKUP}], "nextCursor": None})
        if path == f"/v1/volume-backups/{BACKUP}":
            return self._reply(200, {"id": BACKUP, "state": "ready"})
        if path == f"/v1/volume-backups/{BACKUP}:delete":
            return self._reply(200, {"id": BACKUP, "state": "deleting"})
        if path == "/v1/volumes" and self.command == "POST":
            return self._reply(201, {"id": "vol-2", "state": "creating", "restoredFrom": body.get("fromBackup")})
        return self._reply(404, {"error": {"code": "not_found", "message": path}})

    do_GET = do_POST = _route


class VolumeBackups(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Stub.seen = []

    def test_backup_policy_list_restore_delete(self):
        runtime = Runtime(api_key="rk_test", base_url=self.url, max_retries=0)
        made = runtime.volumes.backup(VOLUME, retention_days=3)
        self.assertEqual(made["id"], BACKUP)
        self.assertEqual(Stub.seen[-1][1:], (f"/v1/volumes/{VOLUME}:backup", "", {"retentionDays": 3}, "wait=60"))
        policy = runtime.volumes.set_backup_policy(VOLUME, daily=False, retention_days=14)
        self.assertEqual(policy["backups"], {"daily": False, "retentionDays": 14})
        self.assertEqual([b["id"] for b in runtime.volumes.backups(VOLUME)], [BACKUP])
        self.assertEqual(Stub.seen[-1][2], f"volumeId={VOLUME}")
        self.assertEqual(runtime.volumes.get_backup(BACKUP)["state"], "ready")
        restored = runtime.volumes.restore(BACKUP, name="again")
        self.assertEqual(restored["restoredFrom"], BACKUP)
        self.assertEqual(Stub.seen[-1][3], {"name": "again", "fromBackup": BACKUP})
        self.assertEqual(runtime.volumes.delete_backup(BACKUP)["state"], "deleting")

    def test_async_twin(self):
        async def main():
            async with AsyncRuntime(api_key="rk_test", base_url=self.url, max_retries=0) as runtime:
                made = await runtime.volumes.backup(VOLUME, wait=0)
                restored = await runtime.volumes.create(from_backup=made["id"])
                return made, restored
        made, restored = asyncio.run(main())
        self.assertEqual(made["id"], BACKUP)
        self.assertEqual(restored["restoredFrom"], BACKUP)
        self.assertEqual(Stub.seen[0][4], None)


if __name__ == "__main__":
    unittest.main()
