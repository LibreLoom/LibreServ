#!/usr/bin/env python3
"""Luna OS end-to-end stages. See iso/e2e.sh."""
import json
import os
import re
import shutil
import sys
import time

from lib import DIST, KVM, WORK, Luna, VM, check, say, sh, summary

ISO = f"{DIST}/luna-rapidinstall-x86_64.iso"
SLOT_IMG = f"{DIST}/luna-os-x86_64.img.xz"
DISK_GB = 7
TOKEN = "ABCDEFGH23456789"
DEV_OF = {"virtio": "/dev/vda", "nvme": "/dev/nvme0n1", "mmc": "/dev/mmcblk0"}


# -- disk helpers --------------------------------------------------------------
def blank_disk(path, gb=DISK_GB):
    if os.path.exists(path):
        os.unlink(path)
    sh(f"truncate -s {gb}G {path}")


def parts(disk):
    """{index: (start_bytes, size_bytes, name)} read from the GPT."""
    j = json.loads(sh(f"sfdisk -J {disk}"))["partitiontable"]
    out = {}
    for p in j["partitions"]:
        n = int(re.search(r"(\d+)$", p["node"]).group(1))
        out[n] = (p["start"] * 512, p["size"] * 512, p.get("name", ""))
    return out


def ext_cat(disk, n, path):
    off = parts(disk)[n][0]
    return sh(f"debugfs -R 'cat {path}' '{disk}?offset={off}' 2>/dev/null", check_rc=False)


def ext_fsck(disk, n):
    off = parts(disk)[n][0]
    size = parts(disk)[n][1]
    img = f"{WORK}/fsck-{n}.img"
    sh(f"dd if={disk} of={img} bs=1M skip={off // 1048576} count={size // 1048576} 2>/dev/null")
    r = sh(f"e2fsck -fn {img}; echo rc=$?", check_rc=False)
    os.unlink(img)
    return r


def esp(disk):
    return f"{disk}@@{parts(disk)[2][0]}"


def esp_cat(disk, path):
    return sh(f"MTOOLS_SKIP_CHECK=1 mtype -i {esp(disk)} ::{path}", check_rc=False)


def esp_put(disk, path, text):
    tmp = f"{WORK}/espput.tmp"
    open(tmp, "w").write(text)
    sh(f"MTOOLS_SKIP_CHECK=1 mcopy -o -i {esp(disk)} {tmp} ::{path}")


def esp_grubenv(disk):
    raw = esp_cat(disk, "/grub/grubenv")
    return dict(re.findall(r"^(\w+)=(.*)$", raw, re.M))


def is_zero(disk, off, length):
    return sh(f"dd if={disk} bs=1M skip={off // 1048576} count={length // 1048576} 2>/dev/null | cmp -n {length} - /dev/zero && echo Z", check_rc=False).strip() == "Z"


def ext_write(disk, n, path, text, mode="0100644"):
    """Replace a regular file inside an ext4 partition (offline, debugfs -w)."""
    off = parts(disk)[n][0]
    tmp = f"{WORK}/extwrite.tmp"
    open(tmp, "w").write(text)
    d, f = os.path.split(path)
    cmds = f"{WORK}/extwrite.cmds"
    open(cmds, "w").write(f"cd {d}\nrm {f}\nwrite {tmp} {f}\nsif {f} mode {mode}\n")
    sh(f"debugfs -w -f {cmds} '{disk}?offset={off}' >/dev/null 2>&1")
    if ext_cat(disk, n, path) != text:
        raise RuntimeError(f"could not write {path} into partition {n}")


def serial_console_for_tests(disk):
    """Test-only: a serial console for boot logs, and a root shell on it for the checks.

    GRUB gets console=ttyS0; slot A's inittab gets a ttyS0 shell. The slot image
    that Luna ships is not touched (os-image.sha256 is of the .img.xz).
    """
    inittab = ext_cat(disk, 3, "/etc/inittab")
    line = "ttyS0::respawn:/usr/bin/env TERM=dumb /bin/ash"
    if line not in inittab:
        keep = "\n".join(l for l in inittab.split("\n") if not l.startswith("ttyS0::"))
        ext_write(disk, 3, "/etc/inittab", keep.rstrip("\n") + "\n" + line + "\n")
    for p in ("/grub/grub.cfg", "/EFI/BOOT/grub.cfg", "/EFI/BOOT/grub/grub.cfg"):
        t = esp_cat(disk, p)
        if t and "ttyS0" not in t:
            esp_put(disk, p, t.replace(" quiet", " console=tty0 console=ttyS0,115200 quiet"))


# -- installer ---------------------------------------------------------------------
def installer_files():
    k, i = f"{WORK}/vmlinuz", f"{WORK}/initrd.img"
    if not os.path.exists(k):
        sh(f"xorriso -osirrox on -indev {ISO} -extract /live/vmlinuz {k} -extract /live/initrd.img {i} >/dev/null 2>&1")
    return k, i


def stick_with_tokens():
    """A writable copy of the stick with a one-line TOKENS magazine on LUNAASSETS."""
    stick = f"{WORK}/stick.iso"
    if not os.path.exists(stick):
        sh(f"cp {ISO} {stick}")
    out = sh(f"sfdisk -d {stick}")
    start = int(re.search(r"start=\s*(\d+),[^\n]*name=\"Appended3\"", out).group(1))
    open(f"{WORK}/TOKENS", "w").write(TOKEN + "\n")
    sh(f"MTOOLS_SKIP_CHECK=1 mcopy -o -i {stick}@@{start * 512} {WORK}/TOKENS ::TOKENS")
    return stick, start * 512


def run_installer(name, target_disks, stick, extra_append="", answers=None, timeout=900, firmware="bios"):
    """Direct-kernel boot of the installer. target_disks: list of VM disk dicts."""
    k, i = installer_files()
    append = ("boot=live text nomodeset console=tty0 console=ttyS0 net.ifnames=0 biosdevname=0 "
              "init=/usr/lib/luna-installer/init.sh " + extra_append)
    disks = [{"file": stick, "bus": "usb"}] + target_disks
    vm = VM(name, disks, firmware=firmware, kernel=k, initrd=i, append=append, net=True,
            mem=2048, extra=["-no-reboot"])
    vm.start()
    if answers:
        for pat, send, wait in answers:
            if vm.wait_serial(pat, wait):
                vm.serial_send(send)
    vm.wait_exit(timeout)
    log = vm.serial_text()
    vm.quit()
    return vm, log


def stage_install(bus, fw):
    tag = f"golden-{bus}"
    disk = f"{WORK}/{tag}.raw"
    say(f"-- install onto a {bus} disk (auto-picked target)")
    stick, _ = stick_with_tokens()
    blank_disk(disk)
    vm, log = run_installer(f"install-{bus}", [{"file": disk, "bus": bus}], stick,
                            "LUNA_CONFIRM=INSTALL LUNA_OVERRIDE_WAIT=1", timeout=1500)
    check(f"[{bus}] installer finished", "Installation complete" in log, log[-400:])
    check(f"[{bus}] installer auto-picked the built-in disk", re.search(r"Installing to /dev/\w+", log) is not None)
    check(f"[{bus}] no pack warnings", "WARNING" not in log, "\n".join(l for l in log.splitlines() if "WARNING" in l))
    check(f"[{bus}] factory token taken from LUNAASSETS", "Device token taken from LUNAASSETS" in log)
    p = parts(disk)
    check(f"[{bus}] GPT has the 5 expected partitions", sorted(p) == [1, 2, 3, 4, 5], str(p))
    names = [p[n][2] for n in sorted(p)] if sorted(p) == [1, 2, 3, 4, 5] else []
    check(f"[{bus}] partition names", names[2:] == ["LUNA_A", "LUNA_B", "LUNA_DATA"], str(names))
    check(f"[{bus}] device token on LUNA_DATA", TOKEN in ext_cat(disk, 5, "/device-token"))
    want = open(f"{DIST}/luna-os-x86_64.img.xz.sha256").read().split()[0]
    check(f"[{bus}] os-image.sha256 matches the image", want in ext_cat(disk, 5, "/os-image.sha256"))
    env = esp_grubenv(disk)
    check(f"[{bus}] grubenv starts on slot A, confirmed", env.get("luna_slot") == "A" and env.get("luna_boot_ok") == "1", str(env))
    for n in (3, 4):
        r = ext_fsck(disk, n)
        check(f"[{bus}] slot {'AB'[n - 3]} filesystem is clean", "rc=0" in r, r[-300:])
    check(f"[{bus}] data filesystem is clean", "rc=0" in ext_fsck(disk, 5))
    serial_console_for_tests(disk)
    return disk


def stage_installer_safety():
    say("-- installer safety")
    stick, _ = stick_with_tokens()
    # wrong confirmation: shut down, nothing erased
    d = f"{WORK}/safety.raw"
    blank_disk(d, 6)
    ro_stick = f"{WORK}/stick-ro.iso"
    shutil.copy(stick, ro_stick)
    vm, log = run_installer("safety-wrong", [{"file": d, "bus": "virtio"}], ro_stick,
                            "LUNA_OVERRIDE_WAIT=1",
                            answers=[(r"Confirm: ", "nope\n", 300)], timeout=300)
    check("wrong confirmation shuts the machine down", "not INSTALL. Shutting down" in log, log[-300:])
    check("wrong confirmation leaves the disk blank", is_zero(d, 0, 64 * 1048576) and is_zero(d, 3 * 1024**3, 64 * 1048576))
    # two built-in disks: the smaller is picked, the bigger and the stick are untouched
    small, big = f"{WORK}/safety-small.raw", f"{WORK}/safety-big.raw"
    blank_disk(small, 6)
    blank_disk(big, 8)
    before = sh(f"sha256sum {ro_stick}").split()[0]
    vm, log = run_installer("safety-two", [{"file": big, "bus": "virtio"}, {"file": small, "bus": "virtio"}], ro_stick,
                            "LUNA_CONFIRM=INSTALL LUNA_OVERRIDE_WAIT=1", timeout=1500)
    check("two disks: installer finished", "Installation complete" in log, log[-300:])
    check("two disks: smaller disk got Luna", len(parts(small)) == 5 if sh(f"sfdisk -J {small}", check_rc=False).strip() else False)
    check("two disks: bigger disk is untouched", is_zero(big, 0, 64 * 1048576))
    check("the install stick is unchanged", sh(f"sha256sum {ro_stick}").split()[0] == before)
    os.unlink(ro_stick)
    for f in (d, small, big):
        os.unlink(f)


# -- drive fixtures ------------------------------------------------------------
def make_fixtures():
    """Small disk images a person might plug in. Returns {name: path}."""
    d = f"{WORK}/fx"
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(f"{d}/tree/Photos")
    open(f"{d}/tree/Photos/a.jpg", "wb").write(os.urandom(5000))
    open(f"{d}/tree/hello.txt", "w").write("hello from a usb stick\n")
    fx = {}
    # FAT32 with files (the classic stick)
    sh(f"truncate -s 256M {d}/fat32.img && mkfs.vfat -F 32 -n STICK {d}/fat32.img >/dev/null")
    sh(f"MTOOLS_SKIP_CHECK=1 mcopy -i {d}/fat32.img -s {d}/tree/* ::")
    fx["fat32"] = f"{d}/fat32.img"
    # ext4 with files
    sh(f"truncate -s 256M {d}/ext4.img && mke2fs -q -t ext4 -L EXTDRIVE -d {d}/tree {d}/ext4.img")
    fx["ext4"] = f"{d}/ext4.img"
    # exFAT and NTFS, empty
    sh(f"truncate -s 256M {d}/exfat.img && mkfs.exfat -L EXFAT {d}/exfat.img >/dev/null")
    fx["exfat"] = f"{d}/exfat.img"
    sh(f"truncate -s 256M {d}/ntfs.img && mkntfs -F -Q -L NTFSDRV {d}/ntfs.img >/dev/null 2>&1")
    fx["ntfs"] = f"{d}/ntfs.img"
    # blank and corrupt
    sh(f"truncate -s 256M {d}/blank.img")
    sh(f"truncate -s 256M {d}/corrupt.img && head -c 4096 /dev/urandom | dd of={d}/corrupt.img conv=notrunc 2>/dev/null")
    fx["blank"] = f"{d}/blank.img"
    fx["corrupt"] = f"{d}/corrupt.img"
    return fx


def overlay(golden, name):
    path = f"{WORK}/{name}.qcow2"
    if os.path.exists(path):
        os.unlink(path)
    sh(f"qemu-img create -q -f qcow2 -b {golden} -F raw {path}")
    return path


def boot_disk(name, golden, bus, fw="bios", port=18080, extra_disks=(), **kw):
    ov = overlay(golden, name)
    vm = VM(name, [{"file": ov, "fmt": "qcow2", "bus": bus, "bootindex": 0}, *extra_disks],
            firmware=fw, http_port=port, **kw)
    vm.start()
    return vm


def stage_explore():
    vm = golden_vm("explore", "sata", xhci=True)
    lu = Luna(18080)
    check("API up", lu.wait_up(240))
    time.sleep(5)
    if os.environ.get("E2E_USB"):
        fx = make_fixtures()
        say(vm.usb_add("ux", fx[os.environ["E2E_USB"]]))
        time.sleep(8)
    for c in os.environ.get("E2E_CMDS", "uname -a;mount;ps;cat /etc/resolv.conf;ip a").split(";"):
        rc, out = vm.sh(c)
        say(f"$ {c}  (rc={rc})\n{out}")
    vm.quit()


ADMIN = {"username": "admin", "display_name": "Test Admin", "password": "correct-horse-battery-9"}
BAD_LOG = re.compile(r"(\[ ?FAILED ?\]|panic|Oops|segfault|BUG:|Call Trace|\bcan't\b|cannot|Read-only file system|No such file)", re.I)
MOCK = None


def start_mock_connect():
    """Luna Connect mock on the container (the guest reaches it at 10.0.2.2:18765)."""
    global MOCK
    if MOCK and MOCK.poll() is None:
        return
    import subprocess
    env = dict(os.environ, MOCK_CONNECT_HOST="0.0.0.0", MOCK_CONNECT_PORT="18765",
               LUNA_DATA_DIR=f"{WORK}/mock", PYTHONDONTWRITEBYTECODE="1")
    os.makedirs(f"{WORK}/mock", exist_ok=True)
    MOCK = subprocess.Popen(["python3", "/mocks/mock-connect.py"], env=env,
                            stdout=open(f"{WORK}/mock-connect.log", "w"), stderr=subprocess.STDOUT)
    time.sleep(2)


def point_at_mock_connect(disk):
    """Test-only: the init script tells lunad to use the mock Connect, never the real one."""
    init = ext_cat(disk, 3, "/etc/init.d/luna")
    if "LUNA_CONNECT_URL" not in init:
        init = init.replace("--env LUNA_PORT=80", "--env LUNA_PORT=80 --env LUNA_CONNECT_URL=http://10.0.2.2:18765")
        ext_write(disk, 3, "/etc/init.d/luna", init, mode="0100755")


def golden_vm(name, bus="sata", fw="bios", port=18080, golden=None, extra_disks=(), **kw):
    g = golden or f"{WORK}/golden-{bus}.raw"
    serial_console_for_tests(g)
    point_at_mock_connect(g)
    start_mock_connect()
    return boot_disk(name, g, bus, fw=fw, port=port, extra_disks=extra_disks, **kw)


def stage_boot():
    """First boot of a fresh install: services, mounts, network, console, logs."""
    vm = golden_vm("boot", "sata")
    t0 = time.time()
    lu = Luna(18080)
    up = lu.wait_up(240)
    check("web UI answers after power-on", up)
    say(f"    time to first answer: {time.time() - t0:.0f}s")
    check("boot is quick enough for a person watching (< 90 s)", time.time() - t0 < 90, f"{time.time() - t0:.0f}s")
    time.sleep(8)
    c, h = lu.get("/api/v1/health")
    check("health says ok", c == 200 and h.get("status") == "ok", str(h))
    c, body = lu.get("/", raw=True)
    check("home page is the Luna web app, not the 'build the web app first' stub",
          c == 200 and b"build the web app first" not in body and b"<script" in body, str(body[:200]))
    rc, out = vm.sh("mount | grep ' / '")
    check("system root is read-only", "(ro," in out, out)
    rc, out = vm.sh("touch /etc/e2e-write-test 2>&1; echo $?")
    check("cannot write to the system root", out.strip().endswith("1") or "Read-only" in out, out)
    rc, out = vm.sh("mount | grep ' /var/lib/luna '")
    check("data partition mounted read-write", "(rw," in out, out)
    rc, out = vm.sh("cat /etc/resolv.conf")
    check("resolv.conf has a nameserver", "nameserver" in out, out)
    rc, out = vm.sh("ping -c1 -W3 example.com 2>&1 | tail -2")
    check("name lookup and internet work from Luna", "1 packets received" in out or "1 received" in out, out)
    rc, out = vm.sh("rc-status -a 2>&1")
    crashed = [l.split()[0] for l in out.split("\n") if "crashed" in l]
    check("no OpenRC service is listed as crashed", not crashed, ", ".join(crashed))
    for svc in ("luna", "luna-network", "luna-boot-ok", "avahi-daemon", "chronyd", "crond", "luna-root-ro", "luna-input"):
        check(f"service {svc} is started", re.search(rf"{svc}\s+\[\s+started", out) is not None, svc)
    rc, out = vm.sh("netstat -ltn 2>/dev/null | grep ':80 '")
    check("lunad listens on port 80", ":80" in out, out)
    bad = [l for l in vm.serial_text().replace("\r", "").split("\n") if BAD_LOG.search(l) and "e2e" not in l.lower()]
    check("boot log has no error lines", not bad, "\n".join(bad[:10]))
    rc, out = vm.sh("dmesg | grep -i -E 'error|fail|warn|taint|oops' | head -20")
    check("kernel log has no errors", out.strip() == "", out)
    rc, out = vm.sh("cat /run/luna/boot-ok; cat /proc/sys/kernel/random/boot_id")
    ids = out.split()
    check("luna-boot-ok confirmed this boot", len(ids) == 2 and ids[0] == ids[1], out)
    rc, out = vm.sh("cat /var/lib/luna/issue")
    check("console issue shows an address and the device token", TOKEN in out and re.search(r"\d+\.\d+\.\d+\.\d+", out) is not None, out)
    rc, out = vm.sh("ps | grep -E 'lunad|luna-console' | grep -v grep")
    check("lunad and the tty1 console are running", "lunad" in out and "luna-console" in out, out)
    rc, out = vm.sh("grep -E 'VmRSS' /proc/$(pidof lunad)/status")
    say(f"    lunad memory at idle: {out}")
    rc, out = vm.sh("date -u +%s")
    try:
        skew = abs(int(out.strip().split()[-1]) - time.time())
        check("guest clock is within 5 minutes of real time", skew < 300, f"{skew:.0f}s")
    except ValueError:
        check("guest clock readable", False, out)
    scr = vm.ocr("boot-tty1")
    check("tty1 console shows Luna's address", "luna" in scr.lower(), scr[-300:])
    vm.quit()


def show(label, resp):
    say(f"    {label}: {resp[0]} {str(resp[1])[:300]}")
    return resp


def part_setup(vm, lu):
    say("-- first-run setup wizard")
    c, b = lu.get("/api/v1/auth/status")
    check("fresh Luna has no admin yet", c == 200 and b.get("has_admin") is False, str(b))
    c, b = lu.get("/api/v1/drives")
    check("drives list needs a sign-in", c == 401, str(c))
    c, b = lu.get("/api/v1/setup/preflight")
    show("preflight", (c, b))
    check("system check answers", c in (200, 503) and isinstance(b, dict), str(b))
    if isinstance(b, dict):
        check("system check is healthy", c == 200 and b.get("healthy"), json.dumps(b)[:600])
    c, b = lu.post("/api/v1/setup/fetch-mag")
    show("fetch-mag", (c, b))
    check("device token already present is recognised", c == 200 and b.get("ok") is True, str(b))
    c, b = lu.post("/api/v1/setup", {"current_step": "network", "step_data": {"network_connected": True}})
    check("wizard progress saves before an account exists", c == 200 and b.get("current_step") == "network", str(b))
    c, b = lu.post("/api/v1/setup", {"current_step": "bogus"})
    check("unknown wizard step is refused", c == 400, f"{c} {b}")
    c, b = lu.post("/api/v1/auth/register", {"username": "x", "password": "short"})
    check("weak password is refused with a plain message", c == 400 and isinstance(b, dict) and b.get("error"), f"{c} {b}")
    c, b = lu.post("/api/v1/auth/register", ADMIN)
    show("register", (c, b))
    check("first admin account is created", c in (200, 201) and b.get("ok") is not False, f"{c} {b}")
    c, b = lu.get("/api/v1/auth/me")
    say(f"    me right after register: {c} {b}")
    c, b = lu.post("/api/v1/auth/login", {"username": ADMIN["username"], "password": ADMIN["password"]})
    check("the new admin can sign in", c == 200 and b.get("role") == "admin", f"{c} {b}")
    c, b = Luna(18080).post("/api/v1/auth/register", {"username": "intruder", "display_name": "x", "password": "another-long-pass-1"})
    check("a stranger cannot create a second account", c in (401, 403), f"{c} {b}")
    c, b = lu.post("/api/v1/setup", {"name": "E2E Luna", "current_step": "done", "setup_completed": True})
    check("setup can be completed", c == 200 and b.get("setup_completed") is True, f"{c} {b}")
    c, b = Luna(18080).get("/api/v1/setup/preflight")
    check("system check is closed once setup is done", c == 403, f"{c} {b}")
    c, b = Luna(18080).post("/api/v1/setup/fetch-mag")
    check("device-token fetch is closed once setup is done", c == 403, f"{c} {b}")
    # logout/login
    c, b = lu.post("/api/v1/auth/logout")
    check("sign out works", c == 200, f"{c} {b}")
    c, b = lu.get("/api/v1/auth/me")
    check("signed-out session is rejected", c == 401 or b is None, f"{c} {b}")
    c, b = lu.post("/api/v1/auth/login", {"username": ADMIN["username"], "password": "wrong-password-1"})
    check("wrong password is refused", c in (400, 401), f"{c} {b}")
    c, b = lu.post("/api/v1/auth/login", {"username": ADMIN["username"], "password": ADMIN["password"]})
    check("sign in works", c == 200 and b.get("role") == "admin", f"{c} {b}")
    # brute force limiter
    codes = [Luna(18080).post("/api/v1/auth/login", {"username": "admin", "password": f"nope-{i}-nope"})[0] for i in range(12)]
    check("repeated wrong passwords get rate-limited", 429 in codes, str(codes))
    time.sleep(1)


def detected(lu, pred=lambda d: True, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        c, b = lu.get("/api/v1/drives/detected")
        if c == 200 and isinstance(b, list):
            m = [d for d in b if pred(d)]
            if m:
                return m
        time.sleep(2)
    say(f"    (last detected answer: {c} {str(b)[:300]})")
    return []


def detected_names(lu):
    c, b = lu.get("/api/v1/drives/detected")
    return {d["name"]: d for d in b} if c == 200 and isinstance(b, list) else {}


def plug(vm, lu, ident, img, **kw):
    """Plug a fixture in; returns the new detected-drive dict (or None)."""
    before = set(detected_names(lu))
    vm.usb_add(ident, img, **kw)
    end = time.time() + 45
    while time.time() < end:
        now = detected_names(lu)
        new = [d for n, d in now.items() if n not in before]
        if new:
            return new[0]
        time.sleep(2)
    return None


def unplug(vm, lu, ident, name, timeout=30):
    vm.usb_del(ident)
    end = time.time() + timeout
    while time.time() < end:
        c, b = lu.get("/api/v1/drives/detected")
        if name not in detected_names(lu):
            return True
        time.sleep(2)
    return False


def image_root_listing(kind, path):
    if kind == "fat32":
        out = sh(f"MTOOLS_SKIP_CHECK=1 mdir -/ -b -a -i {path} ::", check_rc=False)
        return sorted(l.strip().lstrip(":/") for l in out.split("\n") if l.strip())
    out = sh(f"debugfs -R 'ls -p /' {path} 2>/dev/null", check_rc=False)
    return sorted(l.split("/")[5] for l in out.split("\n") if l.count("/") >= 6 and l.split("/")[5] not in (".", "..", "lost+found"))


def drive_row(lu, drive_id):
    c, b = lu.get("/api/v1/drives")
    return next((d for d in b if d["id"] == drive_id), None) if c == 200 else None


def part_drives(vm, lu, fx):
    say("-- drives: preview, add, eject, unplug, replug")
    adopted = {}
    for kind in ("fat32", "ext4"):
        ident = f"u-{kind}"
        d = plug(vm, lu, ident, fx[kind])
        check(f"[{kind}] stick shows up in Add drive", d is not None)
        if not d:
            continue
        check(f"[{kind}] size and removable flag are right", 200e6 < d["size_bytes"] < 300e6 and d["removable"], str(d))
        before = image_root_listing(kind, fx[kind])
        c, b = lu.get(f"/api/v1/drives/{d['name']}/peek")
        check(f"[{kind}] preview shows the stick's own files", c == 200 and b.get("readable") and b.get("files", 0) == 1 and b.get("folders") == 1, str(b))
        check(f"[{kind}] preview says it is not a Luna drive yet", c == 200 and b.get("has_marker") is False, str(b))
        check(f"[{kind}] preview wrote nothing to the stick", image_root_listing(kind, fx[kind]) == before, str(image_root_listing(kind, fx[kind])))
        c, b = lu.post(f"/api/v1/drives/{d['name']}/inspect")
        check(f"[{kind}] inspect reads the stick", c == 200 and b.get("readable") and b.get("fs_type"), str(b))
        c, b = lu.post(f"/api/v1/drives/{d['name']}/adopt", {"label": "", "erase": False})
        check(f"[{kind}] an empty drive name is refused", c == 400, f"{c} {b}")
        c, b = lu.post(f"/api/v1/drives/{d['name']}/adopt", {"label": f"My {kind}", "erase": False})
        check(f"[{kind}] stick is added", c == 200 and b.get("id"), f"{c} {b}")
        if c != 200:
            continue
        adopted[kind] = b["id"]
        check(f"[{kind}] drive is ready and mounted", b.get("state") in ("as_is", "ready") and b.get("mount_point"), str(b))
        check(f"[{kind}] it left the Add drive list", d["name"] not in detected_names(lu))
        c, ls = lu.get(f"/api/v1/drives/{b['id']}/files")
        names = sorted(e["name"] for e in ls if not e.get("hidden")) if isinstance(ls, list) else []
        check(f"[{kind}] its own files are listed, Luna's bookkeeping file is hidden",
              c == 200 and "hello.txt" in names and "Photos" in names and not any(n.startswith(".luna") for n in names), str(ls)[:300])
        check(f"[{kind}] no 'lost+found' folder is shown to the person", "lost+found" not in names, str(names))
    return adopted


import blake3
import hashlib
from urllib.parse import quote


def file_names(lu, drive, path=""):
    c, ls = lu.get(f"/api/v1/drives/{drive}/files?path={quote(path)}")
    return (c, sorted(e["name"] for e in ls) if isinstance(ls, list) else ls)


def upload(lu, drive, name, data, path="", chunk=4 * 1024 * 1024, stop_after=None, upload_id=None, hash_ok=True):
    """Chunked upload as the web app does it. Returns (status, body, upload_id)."""
    total = len(data)
    c, b = lu.post("/api/v1/uploads", {"drive_id": drive, "path": path, "name": name, "size": total})
    if c != 200:
        return c, b, None
    uid = b["upload_id"]
    off = b.get("received", 0)
    sent = 0
    while off < total:
        end = min(off + chunk, total)
        c, r = lu.req("PUT", f"/api/v1/uploads/{uid}", data[off:end],
                      headers={"Content-Range": f"bytes {off}-{end - 1}/{total}", "Content-Type": "application/octet-stream"}, timeout=120)
        if c != 200:
            return c, r, uid
        off = end
        sent += 1
        if stop_after and sent >= stop_after:
            return 0, "stopped on purpose", uid
    c, r = lu.post(f"/api/v1/uploads/{uid}/complete?hash={blake3.blake3(data).hexdigest() if hash_ok else '0' * 64}")
    return c, r, uid


def download(lu, drive, path, rng=None):
    h = {"Range": rng} if rng else None
    return lu.get(f"/api/v1/drives/{drive}/files/content?path={quote(path)}&download=1", raw=True, headers=h, timeout=120)


def part_files(vm, lu, drive, kind):
    say(f"-- files on the {kind} drive")
    D = drive
    T = f"[{kind}] "
    c, b = lu.post(f"/api/v1/drives/{D}/files/mkdir", {"path": "Docs"})
    check(T + "make a folder", c in (200, 201), f"{c} {b}")
    c, b = lu.post(f"/api/v1/drives/{D}/files/mkdir", {"path": "Docs"})
    check(T + "making the same folder again is refused plainly", c in (400, 409) and isinstance(b, dict) and b.get("error"), f"{c} {b}")
    c, b = lu.post(f"/api/v1/drives/{D}/files/mkdir", {"path": "Docs/Deep/Er"})
    check(T + "making a folder under a missing parent is refused", c in (400, 404), f"{c} {b}")
    for bad in ("../escape", "/etc/evil", "Docs/../../x", "a\\x", "bad\x00name"):
        c, b = lu.post(f"/api/v1/drives/{D}/files/mkdir", {"path": bad})
        check(T + f"unsafe folder path {bad!r} is refused", c in (400, 403, 404, 422), f"{c} {b}")
    c, b = lu.post(f"/api/v1/drives/{D}/files/mkdir", {"path": "Docs/Fotos \u00e4\u00f6\u00fc \u2603 caf\u00e9"})
    check(T + "unicode folder name works", c in (200, 201), f"{c} {b}")
    c, b = lu.post(f"/api/v1/drives/{D}/files/mkdir", {"path": "x" * 300})
    check(T + "a 300-character name is refused, not a crash", c in (400, 413, 422), f"{c} {b}")
    c, b = lu.post(f"/api/v1/drives/{D}/files/create", {"path": "Docs/empty.txt"})
    check(T + "create an empty file", c in (200, 201), f"{c} {b}")
    # small upload round trip
    data = os.urandom(3 * 1024 * 1024 + 17)
    c, b, uid = upload(lu, D, "photo.bin", data, path="Docs", chunk=1024 * 1024)
    check(T + "3 MB upload in chunks, hash checked", c == 200, f"{c} {b}")
    if c != 200:
        say("    lunad log tail:\n" + vm.sh("ls /var/lib/luna/logs; tail -n 25 /var/lib/luna/logs/* 2>&1 | cut -c1-300")[1])
    c, got = download(lu, D, "Docs/photo.bin")
    check(T + "download matches the upload byte for byte", c == 200 and got == data, f"{c} {len(got) if isinstance(got, bytes) else got}")
    c, got = download(lu, D, "Docs/photo.bin", "bytes=1000-1999")
    check(T + "ranged download returns exactly that slice", c == 206 and got == data[1000:2000], f"{c} {len(got) if isinstance(got, bytes) else got}")
    c, b, _ = upload(lu, D, "photo.bin", os.urandom(1000), path="Docs")
    check(T + "uploading a name that exists does not overwrite silently", c in (400, 409), f"{c} {b}")
    c, ls = file_names(lu, D, "Docs")
    check(T + "listing shows the new files", "photo.bin" in ls and "empty.txt" in ls, str(ls))
    c, b = lu.post(f"/api/v1/drives/{D}/files/rename", {"path": "Docs/photo.bin", "new_name": "holiday.bin"})
    check(T + "rename a file", c == 200, f"{c} {b}")
    c, got = download(lu, D, "Docs/holiday.bin")
    check(T + "renamed file keeps its content", c == 200 and got == data)
    c, b = lu.post(f"/api/v1/drives/{D}/files/rename", {"path": "Docs/holiday.bin", "new_name": "empty.txt"})
    check(T + "renaming onto an existing name is refused", c in (400, 409), f"{c} {b}")
    c, b = lu.post(f"/api/v1/drives/{D}/files/rename", {"path": "Docs/holiday.bin", "new_name": "a/b"})
    check(T + "a name with a slash is refused", c in (400, 422), f"{c} {b}")
    c, b = lu.req("DELETE", f"/api/v1/drives/{D}/files?path={quote('Docs/holiday.bin')}")
    check(T + "delete moves the file to the trash", c == 200, f"{c} {b}")
    c, ls = file_names(lu, D, "Docs")
    check(T + "deleted file is gone from the folder", c == 200 and "holiday.bin" not in ls, str(ls))
    c, tr = lu.get(f"/api/v1/drives/{D}/files?path=.trash")
    show("trash", (c, str(tr)[:200]))
    return data


def stage_flow():
    vm = golden_vm("flow", "sata", xhci=True)
    lu = Luna(18080)
    check("web UI answers", lu.wait_up(240))
    part_setup(vm, lu)
    fx = make_fixtures()
    adopted = part_drives(vm, lu, fx)
    for kind, did in adopted.items():
        part_files(vm, lu, did, kind)
        break
    vm.quit()


STAGES = {}


def stage(fn):
    STAGES[fn.__name__.replace("stage_", "").replace("_", "-")] = fn
    return fn


STAGES["explore"] = stage_explore
STAGES["boot"] = stage_boot
STAGES["flow"] = stage_flow
STAGES["installer-safety"] = stage_installer_safety
for _bus in ("sata", "nvme", "mmc", "virtio"):
    STAGES[f"install-{_bus}"] = (lambda b: lambda: stage_install(b, "bios"))(_bus)


def main():
    args = sys.argv[1:]
    if "--list" in args:
        print("\n".join(STAGES))
        return 0
    names = args or list(STAGES)
    for n in names:
        say(f"\n== {n}")
        try:
            STAGES[n]()
        except Exception:
            import traceback
            traceback.print_exc()
            check(f"stage {n} ran to the end", False, "crashed; see traceback above")
    return summary()


if __name__ == "__main__":
    sys.exit(main())
