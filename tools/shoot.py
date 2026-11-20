#!/usr/bin/env python3
"""
Photograph the screens for the user's manual:

    python tools/shoot.py [scene ...]

Serve the project folder first (python -m http.server 8450 in the project folder, or the
"wxrouter" entry in Z:\\Claude\\.claude\\launch.json). Each scene of tools/shot.html is opened
in headless Edge, which this script drives over its DevTools connection: it waits until the
scene sets the page title to "ready", then photographs it at phone size (390 x 800 points,
2x) to tools/screens/<scene>.jpg. The route scenes plan a real passage against the live
forecast, so they take a minute or two each and the numbers change from day to day.
Uses only the standard library and Pillow.
"""
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

from PIL import Image
import io

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
BASE = "http://localhost:8450/tools/shot.html?scene="
PORT = 9333
HERE = os.path.dirname(os.path.abspath(__file__))
SCREENS = os.path.join(HERE, "screens")
SCENES = ["first", "settings-limits", "settings-more", "sail", "route-setup", "waypoints",
          "route", "legs", "windows", "havens", "gate", "saved"]


class DevTools:
    """Just enough of a WebSocket client to send DevTools commands and read the replies."""

    def __init__(self, url):
        host, rest = url.split("://", 1)[1].split("/", 1)
        h, p = host.split(":")
        self.s = socket.create_connection((h, int(p)), timeout=600)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET /{rest} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            head += self.s.recv(1)
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise RuntimeError(head.decode(errors="replace"))
        self.n = 0

    def _read(self, k):
        out = b""
        while len(out) < k:
            chunk = self.s.recv(k - len(out))
            if not chunk:
                raise RuntimeError("DevTools connection closed")
            out += chunk
        return out

    def _send(self, text):
        data = text.encode()
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else
                                bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 else
                                bytes([0x80 | 127]) + struct.pack(">Q", n))
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _recv(self):
        msg = b""
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            msg += self._read(n)
            if b0 & 0x80:
                return msg.decode()

    def call(self, method, **params):
        self.n += 1
        self._send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            reply = json.loads(self._recv())
            if reply.get("id") == self.n:
                if "error" in reply:
                    raise RuntimeError(f"{method}: {reply['error']}")
                return reply.get("result", {})


def main(scenes):
    os.makedirs(SCREENS, exist_ok=True)
    work = tempfile.mkdtemp(prefix="wxr-")
    subprocess.Popen([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                      f"--user-data-dir={os.path.join(work, 'profile')}", f"--remote-debugging-port={PORT}",
                      "--window-size=390,800", "about:blank"])
    for _ in range(60):
        try:
            pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
            page = next(p for p in pages if p.get("type") == "page")
            break
        except Exception:
            time.sleep(1)
    else:
        sys.exit("headless Edge did not start")
    dt = DevTools(page["webSocketDebuggerUrl"])
    try:
        dt.call("Emulation.setDeviceMetricsOverride", width=390, height=800, deviceScaleFactor=2, mobile=True)
        for scene in scenes:
            start = time.time()
            dt.call("Runtime.evaluate", expression="document.title = ''")   # never read the last scene's "ready"
            dt.call("Page.navigate", url=BASE + scene)
            time.sleep(2)
            while time.time() - start < 900:
                title = dt.call("Runtime.evaluate", expression="document.title")["result"].get("value")
                if title == "ready":
                    break
                time.sleep(2)
            else:
                print("timed out", scene, flush=True)
                continue
            time.sleep(2)   # chart tiles
            png = base64.b64decode(dt.call("Page.captureScreenshot", format="png")["data"])
            Image.open(io.BytesIO(png)).convert("RGB").save(os.path.join(SCREENS, scene + ".jpg"), quality=88)
            print(f"shot {scene} ({time.time() - start:.0f} s)", flush=True)
    finally:
        try:
            dt.call("Browser.close")
        except Exception:
            pass
        time.sleep(2)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main(sys.argv[1:] or SCENES)
