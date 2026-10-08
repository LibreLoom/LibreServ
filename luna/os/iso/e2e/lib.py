"""Helpers for the Luna OS end-to-end test: QEMU VMs, screen OCR, Luna's HTTP API.

Runs inside the container built from os/iso/Containerfile.qemu (see e2e.sh).
"""
import http.cookiejar
import json
import os
import re
import socket
import threading
import subprocess
import time
import urllib.error
import urllib.request

WORK = os.environ.get("E2E_WORK", "/work")
DIST = os.environ.get("E2E_DIST", "/dist")
KVM = os.access("/dev/kvm", os.W_OK)

_results = []


def say(msg):
    print(msg, flush=True)


CURRENT_VM = None


def check(name, ok, detail=""):
    _results.append((name, bool(ok), detail))
    say(("  PASS  " if ok else "  FAIL  ") + name + (f"  [{detail}]" if detail and not ok else ""))
    if not ok and CURRENT_VM is not None and re.match(r"\s*(500|502|503)\b", str(detail)):
        try:
            rc, out = CURRENT_VM.sh("tail -n 6 /var/lib/luna/logs/luna.log | cut -c1-300", timeout=15)
            say("      lunad log: " + out.replace("\n", "\n      "))
        except Exception:
            pass
    return bool(ok)


def summary():
    bad = [r for r in _results if not r[1]]
    say(f"\n{len(_results) - len(bad)} passed, {len(bad)} failed")
    for n, _, d in bad:
        say(f"  FAILED: {n} {d}")
    return 1 if bad else 0


def sh(cmd, check_rc=True, timeout=None):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    if check_rc and r.returncode != 0:
        raise RuntimeError(f"{cmd}\n{r.stdout}\n{r.stderr}")
    return r.stdout


KEYS = {" ": "spc", "\n": "ret", "-": "minus", "=": "equal", ".": "dot", ",": "comma",
        "/": "slash", "_": "shift-minus", ":": "shift-semicolon", ";": "semicolon"}


def keyname(c):
    if c in KEYS:
        return KEYS[c]
    if c.isupper():
        return "shift-" + c.lower()
    return c


class VM:
    """One QEMU machine. disks: dicts with file, fmt, bus (virtio|sata|nvme|mmc|usb)."""

    def __init__(self, name, disks, firmware="bios", http_port=None, mem=1536, kernel=None,
                 initrd=None, append=None, net=True, extra=(), xhci=False, smp=2, cpus=None):
        self.name = name
        self.http_port = http_port
        self.mon_path = f"{WORK}/{name}.mon"
        self.ser_path = f"{WORK}/{name}.ser"
        self.log = f"{WORK}/{name}.serial.log"
        self.proc = None
        self.mon = None
        self.n = 0
        a = (["taskset", "-c", cpus] if cpus else []) + [
             "qemu-system-x86_64", "-machine", "q35", "-m", str(mem), "-smp", str(smp),
             "-display", "none", "-vga", "std", "-name", name]
        if KVM:
            a += ["-enable-kvm", "-cpu", "host"]
        if firmware == "uefi":
            vars_ = f"{WORK}/{name}.ovmf-vars.fd"
            if not os.path.exists(vars_):
                sh(f"cp /usr/share/OVMF/OVMF_VARS_4M.fd {vars_}")
            a += ["-drive", "if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd",
                  "-drive", f"if=pflash,format=raw,file={vars_}"]
        self.xhci = False
        if xhci:
            a += ["-device", "qemu-xhci,id=xhci"]
            self.xhci = True
        for d in disks:
            a += self._disk_args(d)
        if net:
            fwd = f",hostfwd=tcp:127.0.0.1:{http_port}-:80" if http_port else ""
            a += ["-netdev", f"user,id=n0{fwd}", "-device", "virtio-net-pci,netdev=n0"]
        else:
            a += ["-net", "none"]
        if kernel:
            a += ["-kernel", kernel, "-initrd", initrd, "-append", append]
        a += ["-monitor", f"unix:{self.mon_path},server,nowait",
              "-chardev", f"socket,id=ser0,path={self.ser_path},server=on,wait=off",
              "-serial", "chardev:ser0"]
        a += list(extra)
        self.args = a

    def _disk_args(self, d):
        self.n += 1
        i = f"d{self.n}"
        fmt = d.get("fmt", "raw")
        ro = ",readonly=on" if d.get("readonly") else ""
        if d.get("throttle"):  # bytes/s read,write: a slow eMMC chip
            r_, w_ = d["throttle"]
            ro += f",throttling.bps-read={r_},throttling.bps-write={w_}"
        a = ["-drive", f"if=none,id={i},file={d['file']},format={fmt}{ro}"]
        bus = d.get("bus", "virtio")
        bi = f",bootindex={d['bootindex']}" if "bootindex" in d else ""
        serial = f",serial={d.get('serial', 'LUNA' + i)}"
        if bus == "virtio":
            a += ["-device", f"virtio-blk-pci,drive={i}{serial}{bi}"]
        elif bus == "sata":
            self.sata_n = getattr(self, "sata_n", -1) + 1
            a += ["-device", f"ide-hd,drive={i},bus=ide.{self.sata_n}{serial}{bi}"]
        elif bus == "nvme":
            a += ["-device", f"nvme,drive={i}{serial}{bi}"]
        elif bus == "mmc":
            a += ["-device", "sdhci-pci", "-device", f"sd-card,drive={i}"]
        elif bus == "usb":
            if not self.xhci:
                a += ["-device", "qemu-xhci,id=xhci"]
                self.xhci = True
            a += ["-device", f"usb-storage,drive={i},bus=xhci.0{bi}"]
        return a

    # -- lifecycle ---------------------------------------------------------
    def start(self):
        for p in (self.mon_path, self.ser_path, self.log):
            if os.path.exists(p):
                os.unlink(p)
        global CURRENT_VM
        CURRENT_VM = self
        self.proc = subprocess.Popen(self.args, stdout=subprocess.DEVNULL, stderr=open(f"{WORK}/{self.name}.qemu.err", "w"))
        for _ in range(100):
            if os.path.exists(self.mon_path):
                break
            time.sleep(0.1)
        self._ser = None
        open(self.log, "wb").close()
        for _ in range(100):
            if os.path.exists(self.ser_path):
                break
            time.sleep(0.1)
        for _ in range(100):
            self._ser = socket.socket(socket.AF_UNIX)
            try:
                self._ser.connect(self.ser_path)
                break
            except (ConnectionRefusedError, FileNotFoundError):
                self._ser.close()
                time.sleep(0.2)
        else:
            raise RuntimeError(f"{self.name}: QEMU never opened its serial console; see {WORK}/{self.name}.qemu.err")
        threading.Thread(target=self._drain, daemon=True).start()
        self.mon = socket.socket(socket.AF_UNIX)
        self.mon.connect(self.mon_path)
        self.mon.settimeout(20)
        self._read_prompt()
        return self

    def _drain(self):
        with open(self.log, "ab", buffering=0) as f:
            while True:
                try:
                    b = self._ser.recv(65536)
                except OSError:
                    return
                if not b:
                    return
                f.write(b)

    def _read_prompt(self):
        buf = b""
        while not buf.endswith(b"(qemu) "):
            chunk = self.mon.recv(65536)
            if not chunk:
                break
            buf += chunk
        return buf.decode(errors="replace")

    def hmp(self, cmd):
        self.mon.sendall(cmd.encode() + b"\n")
        return self._read_prompt()

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def kill(self):
        """Power cut: no clean shutdown."""
        if self.alive():
            self.proc.kill()
            self.proc.wait()

    def quit(self):
        if self.alive():
            try:
                self.hmp("quit")
            except Exception:
                pass
            try:
                self.proc.wait(10)
            except Exception:
                self.proc.kill()

    def wait_exit(self, timeout):
        try:
            self.proc.wait(timeout)
            return True
        except subprocess.TimeoutExpired:
            return False

    # -- input / screen ----------------------------------------------------
    def type(self, text, delay=0.12):
        for c in text:
            self.hmp(f"sendkey {keyname(c)}")
            time.sleep(delay)

    def key(self, k):
        self.hmp(f"sendkey {k}")

    def serial_send(self, text):
        """Type into the serial console. Slow and chunked: the UART has no flow control."""
        for i in range(0, len(text), 8):
            self._ser.sendall(text[i:i + 8].encode())
            time.sleep(0.03)

    def serial_text(self):
        try:
            return open(self.log, "rb").read().decode(errors="replace")
        except FileNotFoundError:
            return ""

    def wait_serial(self, pattern, timeout=120):
        end = time.time() + timeout
        while time.time() < end:
            if re.search(pattern, self.serial_text()):
                return True
            if not self.alive():
                return bool(re.search(pattern, self.serial_text()))
            time.sleep(1)
        return False

    def sh(self, cmd, timeout=60):
        """Run a command in the guest's serial root shell; returns (exit_code, output)."""
        self.n_sh = getattr(self, "n_sh", 0) + 1
        mark = f"E2E{self.n_sh}X{int(time.time()) % 100000}"
        start = len(self.serial_text())
        # `echo` first: output without a final newline (curl) must not swallow the marker line.
        self.serial_send(f"{cmd}\n__rc=$?; echo; echo {mark}_${{__rc}}_\n")
        end = time.time() + timeout
        while time.time() < end:
            t = self.serial_text()[start:]
            m = re.search(rf"^{mark}_(\d+)_\r?$", t, re.M)
            if m:
                # What came back: the echo of the typed command (wrapped at the terminal width),
                # its output, the prompt, then the echo of the marker line. Keep only the output.
                body = t[:m.start()].replace("\r", "")
                body = re.sub(r"(~ # )+(\x1b\[6n)?", "", body)
                # Remove the echoes of both typed lines wherever they landed (a slow command
                # prints its output after the second line has already been echoed).
                line2 = f"__rc=$?; echo; echo {mark}_${{__rc}}_"
                for typed in (cmd, line2):
                    if "\n" not in typed:
                        pat = "\n?".join(re.escape(ch) for ch in typed)
                        body = re.sub(pat, "", body, count=1)
                return int(m.group(1)), body.strip()
            time.sleep(0.3)
        return -1, "(timeout) " + self.serial_text()[start:][-300:]

    def screenshot(self, name=None):
        name = name or f"{self.name}-{int(time.time())}"
        ppm = f"{WORK}/{name}.ppm"
        png = f"{WORK}/{name}.png"
        self.hmp(f"screendump {ppm}")
        time.sleep(0.5)
        sh(f"pnmtopng {ppm} > {png} && rm -f {ppm}")
        return png

    def ocr(self, name=None):
        png = self.screenshot(name)
        # scale up: VGA text is small
        sh(f"convert {png} -resize 200% -colorspace Gray {png}.big.png")
        return sh(f"tesseract {png}.big.png - 2>/dev/null", check_rc=False)

    def wait_screen(self, pattern, timeout=120, interval=3):
        end = time.time() + timeout
        txt = ""
        while time.time() < end:
            txt = self.ocr(f"{self.name}-wait")
            if re.search(pattern, txt, re.I):
                return True
            time.sleep(interval)
        say(f"    (screen text at timeout: {txt.strip()[-300:]!r})")
        return False

    # -- hotplug -----------------------------------------------------------
    def usb_add(self, ident, file, fmt="raw", removable=True):
        if not self.xhci:
            raise RuntimeError("VM was started without a USB controller (give it a usb disk or -device qemu-xhci,id=xhci)")
        self.hmp(f"drive_add 0 if=none,id={ident},file={file},format={fmt}")
        return self.hmp(f"device_add usb-storage,id=dev-{ident},drive={ident},bus=xhci.0,removable={'on' if removable else 'off'}")

    def usb_del(self, ident):
        r = self.hmp(f"device_del dev-{ident}")
        time.sleep(1)
        self.hmp(f"drive_del {ident}")
        return r


# -- Luna HTTP API -----------------------------------------------------------
class Luna:
    def __init__(self, port):
        self.base = f"http://127.0.0.1:{port}"
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def req(self, method, path, body=None, headers=None, raw=False, timeout=30):
        data = None
        h = dict(headers or {})
        if method not in ("GET", "HEAD"):
            for c in self.jar:
                if c.name == "luna_csrf":
                    h.setdefault("X-CSRF-Token", c.value)
        if body is not None and not isinstance(body, (bytes, bytearray)):
            data = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        elif body is not None:
            data = body
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with self.op.open(r, timeout=timeout) as resp:
                b = resp.read()
                code = resp.status
        except urllib.error.HTTPError as e:
            b = e.read()
            code = e.code
        except Exception as e:  # connection refused, reset, timeout
            return 0, str(e)
        if raw:
            return code, b
        try:
            return code, json.loads(b)
        except Exception:
            return code, b.decode(errors="replace")

    def get(self, p, **k):
        return self.req("GET", p, **k)

    def post(self, p, body=None, **k):
        return self.req("POST", p, body if body is not None else {}, **k)

    def wait_up(self, timeout=180):
        end = time.time() + timeout
        while time.time() < end:
            c, _ = self.get("/api/v1/health", timeout=5)
            if c == 200:
                return True
            time.sleep(2)
        return False
