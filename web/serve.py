#!/usr/bin/env python3
"""Static server for the browser build, and the signaling relay the plain page uses.

Files: the right wasm MIME type and no caching. GitHub Pages and itch send no
cross-origin isolation headers (the game uses no threads), so neither does this.

Signaling (web/js/signal.js): POST /signal/<topic> with a JSON body sends it to everyone
listening on GET /signal/<topic>, a server-sent event stream. Topics and messages live
in memory only. Players on other machines must load the page from this server.

Run from the build dir (build_web/ or dist/):  python3 serve.py [port]
"""
import json, queue, sys, threading
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

MAX_MESSAGE = 64 * 1024
topics = {}                      # topic -> set of queues, one per listener
topics_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
        ".data": "application/octet-stream",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def topic(self):
        if not self.path.startswith("/signal/"):
            return None
        name = self.path[len("/signal/"):].split("?")[0]
        return name if 0 < len(name) <= 200 else None

    def do_GET(self):
        name = self.topic()
        if name is None:
            return super().do_GET()
        q = queue.Queue(maxsize=1000)
        with topics_lock:
            topics.setdefault(name, set()).add(q)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b": open\n\n")
            self.wfile.flush()
            while True:
                try:
                    data = q.get(timeout=15)
                    self.wfile.write(b"data: " + data + b"\n\n")
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with topics_lock:
                listeners = topics.get(name)
                if listeners is not None:
                    listeners.discard(q)
                    if not listeners:
                        del topics[name]

    def do_POST(self):
        name = self.topic()
        length = int(self.headers.get("Content-Length") or 0)
        if name is None or not 0 < length <= MAX_MESSAGE:
            self.send_error(404 if name is None else 413)
            return
        body = self.rfile.read(length)
        try:
            data = json.dumps(json.loads(body), separators=(",", ":")).encode()
        except ValueError:
            self.send_error(400)
            return
        with topics_lock:
            listeners = list(topics.get(name, ()))
        for q in listeners:
            try:
                q.put_nowait(data)
            except queue.Full:
                pass
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith("/signal/"):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    # A browser opens many connections at once, and each signaling listener holds one
    # open; a larger listen queue keeps the OS from resetting some of them.
    ThreadingHTTPServer.request_queue_size = 128
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
