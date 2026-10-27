#!/usr/bin/env python3
"""Tiny static server for the build: the right wasm MIME type and no caching, and
nothing else. GitHub Pages and itch send no cross-origin isolation headers (the
game uses no threads), so neither does this: what works here works there.
Run from the build dir (build_web/ or dist/)."""
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


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


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    # Threaded so the big .wasm and .data can stream in parallel instead of
    # one-at-a-time (which made the loading screen crawl / look frozen).
    # A browser opens many connections at once; the default listen queue of 5 made
    # the OS reset some of them (a script missing at random, in tests).
    ThreadingHTTPServer.request_queue_size = 128
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
