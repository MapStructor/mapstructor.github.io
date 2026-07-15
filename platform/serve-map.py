#!/usr/bin/env python3
"""MapStructor local map server.

Static file server with HTTP Range support. Python's built-in `http.server` ignores
Range headers (it always returns the whole file); .pmtiles map data is read by byte
range, so downloads that embed their data are served by this script instead.
Stdlib only — no pip installs. Usage:  python serve-map.py [port]
"""
import http.server
import os
import re
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8801


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(
        http.server.SimpleHTTPRequestHandler.extensions_map,
        **{".pmtiles": "application/octet-stream", ".pbf": "application/x-protobuf",
           ".geojson": "application/geo+json", ".mjs": "text/javascript"}
    )

    def do_GET(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path.split("?")[0].split("#")[0])
        if rng and os.path.isfile(path):
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if m and (m.group(1) or m.group(2)):
                self.serve_range(path, m)
                return
        super().do_GET()

    def serve_range(self, path, m):
        try:
            size = os.path.getsize(path)
        except OSError:
            self.send_error(404, "File not found")
            return
        a, b = m.group(1), m.group(2)
        if a:
            start = int(a)
            end = int(b) if b else size - 1
        else:  # suffix form "bytes=-N": the final N bytes
            start = max(0, size - int(b))
            end = size - 1
        end = min(end, size - 1)
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.end_headers()
            return
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # browser cancelled the request — normal during map panning

    def log_message(self, fmt, *args):
        pass  # quiet: map tiles generate a lot of requests


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)) or ".")
    server = http.server.ThreadingHTTPServer(("", PORT), RangeHandler)
    print("Serving this folder at http://localhost:%d - keep this window open while using the map." % PORT)
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
