import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "api_smokecheck.py"
spec = importlib.util.spec_from_file_location("api_smokecheck", MODULE_PATH)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class TestHandler(BaseHTTPRequestHandler):
    mode = "normal"

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(n))
        if self.headers.get("Authorization") != "Bearer test-secret":
            self.send_error(401)
            return
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        mode = "stream" if request.get("stream") else ("tool" if request.get("tools") else "normal")
        if mode == "stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b'data: {"choices":[{"delta":{"content":"PO"}}]}\n\n')
            self.wfile.write(b'data: {"choices":[{"delta":{"content":"NG"}}]}\n\n')
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        if mode == "tool":
            message = {"tool_calls": [{"function": {"name": "echo", "arguments": json.dumps({"value": "ping"})}}]}
        else:
            message = {"content": "PONG"}
        body = json.dumps({"choices": [{"message": message}], "usage": {"total_tokens": 12}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


class SmokecheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_normal_response(self):
        result = smoke.run(self.base, "mock-model", "test-secret", "normal")
        self.assertTrue(result["success"])
        self.assertEqual(result["usage_reported"], {"total_tokens": 12})

    def test_stream_response(self):
        result = smoke.run(self.base, "mock-model", "test-secret", "stream")
        self.assertEqual(result["result"], "stream_verified")
        self.assertIsNotNone(result["time_to_first_content_ms"])

    def test_tool_call(self):
        result = smoke.run(self.base, "mock-model", "test-secret", "tool")
        self.assertEqual(result["result"], "tool_call_verified")

    def test_remote_plain_http_rejected(self):
        with self.assertRaises(smoke.SmokecheckError):
            smoke.completion_url("http://api.vendor.example/v1")

    def test_auth_failure_redacts_secret(self):
        with self.assertRaises(smoke.SmokecheckError) as failure:
            smoke.run(self.base, "mock-model", "do-not-print-me", "normal")
        self.assertNotIn("do-not-print-me", str(failure.exception))


if __name__ == "__main__":
    unittest.main()
