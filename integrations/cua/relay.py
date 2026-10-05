"""Runs inside a Perpetual-owned Cua desktop, never on the host: one request to computer-server on the guest's loopback.

A desktop publishes no port. Perpetual runs this file's source through docker exec in its verified container, as
`python -I -c SOURCE PORT METHOD PATH TIMEOUT` with a POST body on stdin: src/sandbox/cua-local.ts to check readiness
and bridge.py for each SDK command. It writes computer-server's response body to stdout and exits 0 when the answer
is HTTP 200, or exits 3 when computer-server cannot be reached or answers another status; callers then discard its
output. It uses the standard library only, since it runs with computer-server's own Python.
"""

import http.client
import shutil
import sys


def main(port, method, path, timeout):
    body = sys.stdin.buffer.read() if method == "POST" else None
    try:
        connection = http.client.HTTPConnection("127.0.0.1", int(port), timeout=float(timeout))
        connection.request(method, path, body, {"Content-Type": "application/json"} if body is not None else {})
        response = connection.getresponse()
        if response.status != 200:
            return 3
        shutil.copyfileobj(response, sys.stdout.buffer)
    except (OSError, http.client.HTTPException):
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main(*sys.argv[1:5]))
