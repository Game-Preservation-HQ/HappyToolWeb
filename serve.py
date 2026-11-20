"""Serve HappyTool web on http://localhost:8000 (or the port given as the first argument).

Plain `python -m http.server` works too, except on Windows PCs whose registry maps .js to text/plain,
which stops browsers from loading the page's modules. This server always sends the right types.
"""
import functools
import http.server
import pathlib
import sys

TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.md': 'text/markdown; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        return TYPES.get(pathlib.Path(path).suffix.lower()) or super().guess_type(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = pathlib.Path(__file__).resolve().parent
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=str(root)))
    print(f'HappyTool web: http://localhost:{port}/  (Ctrl+C to stop)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
