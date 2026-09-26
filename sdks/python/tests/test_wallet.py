"""open_wallet_account and claim_wallet_account against a stub website."""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from withruntime import RuntimeError
from withruntime.wallet import claim_wallet_account, open_wallet_account


class Stub(BaseHTTPRequestHandler):
    seen: list = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        Stub.seen.append((self.path, body, self.headers.get("authorization")))
        status, answer = ((404, {"error": "That claim code opens no account."}) if self.path.endswith("/claim")
                          else (201, {"claimCode": "rtclaim_x", "amount": "20.000000"}))
        data = json.dumps(answer).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class WalletTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_open_and_claim(self):
        Stub.seen = []
        opened = open_wallet_account(20, accept_terms=True, auth_url=self.url)
        self.assertEqual(opened["claimCode"], "rtclaim_x")
        with self.assertRaises(RuntimeError) as refused:
            claim_wallet_account("rtclaim_nope", auth_url=self.url)
        self.assertEqual(refused.exception.status, 404)
        self.assertEqual(Stub.seen, [
            ("/api/wallet/topups", {"usd": 20, "acceptTerms": True}, None),
            ("/api/wallet/claim", {"claimCode": "rtclaim_nope"}, None),
        ])


if __name__ == "__main__":
    unittest.main()
