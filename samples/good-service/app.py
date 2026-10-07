"""Tiny HTTP service used to demo Sentinel-X. Replies on / and /health."""
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DELAY_MS = int(os.environ.get("DELAY_MS", "0"))   # artificial per-request latency
PORT = int(os.environ.get("PORT", "8080"))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if DELAY_MS:
            time.sleep(DELAY_MS / 1000)
        body = b'{"status":"ok"}' if self.path.startswith("/health") else b"hello from the sample service\n"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
