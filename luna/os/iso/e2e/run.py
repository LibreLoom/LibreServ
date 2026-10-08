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
    blank_disk(disk, 8 if bus == "mmc" else DISK_GB)  # QEMU's SD card must be a power of two
    vm, log = run_installer(f"install-{bus}", [{"file": disk, "bus": bus}], stick,
                            "LUNA_CONFIRM=INSTALL LUNA_OVERRIDE_WAIT=1", timeout=1500)
    check(f"[{bus}] installer finished", "Installation complete" in log, log[-400:])
    check(f"[{bus}] installer auto-picked the built-in disk", re.search(r"Installing to /dev/\w+", log) is not None)
    check(f"[{bus}] no pack warnings", "WARNING" not in log, "\n".join(l for l in log.splitlines() if "WARNING" in l))
    check(f"[{bus}] factory token taken from LUNAASSETS", "Device token taken from LUNAASSETS" in log)
    p = parts(disk)
    check(f"[{bus}] GPT has the 5 expected partitions", sorted(p) == [1, 2, 3, 4, 5], str(p))
    names = [p[n][2] for n in sorted(p)] if sorted(p) == [1, 2, 3, 4, 5] else []
    # lunad finds the slots and the boot partition by these exact GPT names when it applies an OS update
    check(f"[{bus}] partition names", names == ["BIOSGRUB", "LUNAESP", "LUNA_A", "LUNA_B", "LUNA_DATA"], str(names))
    check(f"[{bus}] device token on LUNA_DATA", TOKEN in ext_cat(disk, 5, "/device-token"))
    want = open(f"{DIST}/luna-os-x86_64.img.xz.sha256").read().split()[0]
    check(f"[{bus}] os-image.sha256 matches the image", want in ext_cat(disk, 5, "/os-image.sha256"))
    env = esp_grubenv(disk)
    check(f"[{bus}] grubenv starts on slot A, confirmed", env.get("luna_slot") == "A" and env.get("luna_boot_ok") == "1", str(env))
    for n in (3, 4):
        r = ext_fsck(disk, n)
        check(f"[{bus}] slot {'AB'[n - 3]} filesystem is clean", "rc=0" in r, r[-300:])
    check(f"[{bus}] data filesystem is clean", "rc=0" in ext_fsck(disk, 5))
    # The slot image is only rebuilt when OS inputs change, and lunad is not an
    # input: a newer lunad binary is easily left out of the image by accident.
    off = parts(disk)[3][0]
    baked = f"{WORK}/baked-lunad"
    sh(f"debugfs -R 'dump /usr/local/bin/lunad {baked}' '{disk}?offset={off}' >/dev/null 2>&1", check_rc=False)
    same = os.path.exists(baked) and sha256_file(baked) == sha256_file(LUNAD_BIN)
    check(f"[{bus}] the lunad inside the OS image is the one just built (else rebuild with LUNA_OS_FORCE=1)", same)
    if os.path.exists(baked):
        os.unlink(baked)
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
    # Only the small LUNAASSETS partition at the end may change (the factory token is used up).
    same = sh(f"cmp -n 800000000 {ISO} {ro_stick} && echo same", check_rc=False).strip().endswith("same")
    check("the install stick's installer image is unchanged", same)
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


def overlay_to_raw(name):
    """Flatten a VM's overlay to a raw file so the offline helpers can read it."""
    raw = f"{WORK}/{name}.flat.raw"
    sh(f"qemu-img convert -O raw {WORK}/{name}.qcow2 {raw}")
    return raw


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
    check("tty1 console shows the web address to open", "10.0.2.15" in scr.replace(" ", "") or "luna.local" in scr, scr[-400:])
    check("tty1 console shows the device token", "ABCDEFGH" in scr.replace(" ", "").upper(), scr[-400:])
    check("tty1 console does not tell anyone to use a terminal for normal use", "Login below is only for recovery" in scr or "recovery" in scr.lower(), scr[-400:])
    vm.type("root\n", 0.15)
    time.sleep(3)
    vm.key("ret")
    time.sleep(3)
    vm.type("echo console-works\n", 0.12)
    time.sleep(2)
    scr2 = vm.ocr("boot-tty1-shell")
    check("the recovery login on the screen works with an empty password", "console-works" in scr2, scr2[-300:])
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


def part_ratelimit():
    say("-- sign-in rate limit (last, it locks this client out for a few minutes)")
    codes = [Luna(18080).post("/api/v1/auth/login", {"username": "admin", "password": f"nope-{i}-nope"})[0] for i in range(12)]
    check("repeated wrong passwords get rate-limited", 429 in codes, str(codes))
    c, b = Luna(18080).post("/api/v1/auth/login", {"username": "admin", "password": ADMIN["password"]})
    check("while rate-limited even the right password waits", c == 429, f"{c} {b}")


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
        img = copy_fixture(fx, kind, kind + "-main")
        d = plug(vm, lu, ident, img)
        check(f"[{kind}] stick shows up in Add drive", d is not None)
        if not d:
            continue
        check(f"[{kind}] size and removable flag are right", 200e6 < d["size_bytes"] < 300e6 and d["removable"], str(d))
        before = image_root_listing(kind, img)
        c, b = lu.get(f"/api/v1/drives/{d['name']}/peek")
        check(f"[{kind}] preview shows the stick's own files", c == 200 and b.get("readable") and b.get("files", 0) == 1 and b.get("folders") == 1, str(b))
        check(f"[{kind}] preview says it is not a Luna drive yet", c == 200 and b.get("has_marker") is False, str(b))
        check(f"[{kind}] preview wrote nothing to the stick", image_root_listing(kind, img) == before, str(image_root_listing(kind, img)))
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
import urllib.request
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


def part_people(vm, lu, drive):
    """Members, sharing, public links, private folders, WebDAV."""
    say("-- people: members, sharing, links, private folders, WebDAV")
    D = drive
    c, b = lu.post("/api/v1/users", {"username": "sam", "display_name": "Sam", "password": "sams-long-password-7", "role": "member"})
    check("admin adds a member", c in (200, 201), f"{c} {b}")
    sam_id = b.get("id") if isinstance(b, dict) else None
    c, b = lu.post("/api/v1/users", {"username": "sam", "display_name": "Sam 2", "password": "sams-long-password-7", "role": "member"})
    check("a second 'sam' is refused plainly", c in (400, 409) and isinstance(b, dict) and b.get("error"), f"{c} {b}")
    c, b = lu.post("/api/v1/users", {"username": "weak", "display_name": "Weak", "password": "123", "role": "member"})
    check("a member with a weak password is refused", c == 400, f"{c} {b}")
    sam = Luna(18080)
    c, b = sam.post("/api/v1/auth/login", {"username": "sam", "password": "sams-long-password-7"})
    check("the member can sign in", c == 200 and b.get("role") == "user", f"{c} {b}")
    for path, what in (("/api/v1/drives/detected", "drive scan"), ("/api/v1/system/updates", "updates"),
                       ("/api/v1/system/updates/source", "update source"), ("/api/v1/users", "user list")):
        c, b = sam.get(path)
        check(f"a member cannot open {what}", c == 403, f"{c} {b}")
    c, b = sam.post("/api/v1/users", {"username": "evil", "display_name": "E", "password": "evil-long-password-1", "role": "admin"})
    check("a member cannot create an admin", c == 403, f"{c} {b}")
    c, b = sam.post(f"/api/v1/drives/{D}/files/mkdir", {"path": "SamsDir"})
    check("a member without a share cannot write to the drive", c in (403, 404), f"{c} {b}")
    c, b = sam.get(f"/api/v1/drives/{D}/files?path=Docs")
    check("a member without a share cannot list a folder", c in (403, 404), f"{c} {b}")
    # share Docs read-only
    c, b = lu.post("/api/v1/access/members", {"kind": "path", "drive_id": D, "path": "Docs", "user_id": sam_id, "caps": "view"})
    check("admin shares Docs with the member (view)", c in (200, 201), f"{c} {b}")
    mid = b.get("id") if isinstance(b, dict) else None
    c, b = sam.get(f"/api/v1/drives/{D}/files?path=Docs")
    check("the member can now list Docs", c == 200 and isinstance(b, list), f"{c} {b}")
    c, got = download(sam, D, "Docs/empty.txt")
    check("the member can read a file in Docs", c == 200, f"{c} {got}")
    c, b = sam.post(f"/api/v1/drives/{D}/files/mkdir", {"path": "Docs/ByS"})
    check("view-only: the member cannot make a folder", c in (403, 404), f"{c} {b}")
    c, b, _ = upload(sam, D, "x.bin", b"abc", path="Docs")
    check("view-only: the member cannot upload", c in (403, 404), f"{c} {b}")
    c, b = sam.req("DELETE", f"/api/v1/drives/{D}/files?path={quote('Docs/empty.txt')}")
    check("view-only: the member cannot delete", c in (403, 404), f"{c} {b}")
    c, b = sam.get(f"/api/v1/drives/{D}/files?path=")
    show("member at drive root", (c, b))
    c, b = sam.get(f"/api/v1/drives/{D}/files?path=../")
    check("path escape through a share is refused", c in (400, 403, 404), f"{c} {b}")
    c, b = lu.req("PATCH", f"/api/v1/access/members/{mid}", {"caps": "view+upload"})
    check("admin lets the member upload", c == 200, f"{c} {b}")
    c, b, _ = upload(sam, D, "fromsam.bin", b"hello from sam", path="Docs")
    check("the member can now upload into Docs", c == 200, f"{c} {b}")
    c, b = lu.req("DELETE", f"/api/v1/access/members/{mid}")
    check("admin takes the share away", c == 200, f"{c} {b}")
    c, b = sam.get(f"/api/v1/drives/{D}/files?path=Docs")
    check("the member loses access at once", c in (403, 404), f"{c} {b}")
    # private folder
    c, b = lu.post(f"/api/v1/drives/{D}/files/mkdir", {"path": "Secret", "private": True})
    check("admin makes a private folder", c in (200, 201), f"{c} {b}")
    c, b = lu.get(f"/api/v1/drives/{D}/files?path=Secret")
    check("the owner can open their private folder", c == 200, f"{c} {b}")
    c, b = sam.get(f"/api/v1/drives/{D}/files?path=Secret")
    check("another member cannot open it", c in (403, 404), f"{c} {b}")
    # public link
    c, b = lu.post("/api/v1/access/links", {"kind": "path", "drive_id": D, "path": "Docs", "caps": "view", "password": "open-sesame-1", "expires_in_days": 7})
    show("create link", (c, b))
    check("admin makes a password-protected public link", c in (200, 201), f"{c} {b}")
    tok = None
    if isinstance(b, dict):
        tok = b.get("token") or (b.get("link") or {}).get("token")
        url = b.get("url") or ""
        if not tok and "/s/" in url:
            tok = url.split("/s/")[-1].split("?")[0]
    check("the link has a token", bool(tok), str(b))
    if tok:
        anon = Luna(18080)
        c, b = anon.get(f"/s/{tok}/list")
        check("without the password the link shows nothing", c in (401, 403), f"{c} {str(b)[:200]}")
        c, b = anon.get(f"/s/{tok}/list", headers={"X-Share-Password": "wrong-password-1"})
        check("a wrong link password is refused", c == 401, f"{c} {b}")
        c, b = anon.get(f"/s/{tok}/list", headers={"X-Share-Password": "open-sesame-1"})
        check("with the right password the link lists the folder", c == 200 and "empty.txt" in str(b), f"{c} {str(b)[:200]}")
        c, b = anon.get(f"/s/{tok}/list")
        check("after unlocking, the browser stays unlocked", c == 200, f"{c} {str(b)[:200]}")
        c, got = anon.get(f"/s/{tok}/file?path=empty.txt", raw=True)
        check("the link can download a file", c == 200, f"{c}")
        c, b = anon.post(f"/s/{tok}/mkdir", {"path": "hack"})
        check("a view link cannot create things", c in (400, 401, 403, 404), f"{c} {b}")
        c, b = anon.get("/s/not-a-real-token/list")
        check("an unknown link token is refused", c in (401, 403, 404), f"{c} {b}")
    # WebDAV with the session cookie
    base = f"/dav/{D}"
    c, b = lu.req("PROPFIND", base + "/", b'<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>', headers={"Depth": "1", "Content-Type": "application/xml"})
    check("WebDAV lists the drive", c == 207 and (b if isinstance(b, str) else str(b)).count("<D:response>") + str(b).count("<d:response>") + str(b).lower().count("response>") >= 2, f"{c} {str(b)[:200]}")
    c, b = lu.req("MKCOL", base + "/FromDav")
    check("WebDAV can make a folder", c in (200, 201), f"{c} {b}")
    payload = os.urandom(200000)
    c, b = lu.req("PUT", base + "/FromDav/blob.bin", payload, headers={"Content-Type": "application/octet-stream"})
    check("WebDAV can upload a file", c in (200, 201, 204), f"{c} {b}")
    c, got = lu.req("GET", base + "/FromDav/blob.bin", raw=True)
    check("WebDAV download matches", c == 200 and got == payload, f"{c}")
    c, got = download(lu, D, "FromDav/blob.bin")
    check("a file put over WebDAV shows up in the web app", c == 200 and got == payload, f"{c}")
    c, b = lu.req("MOVE", base + "/FromDav/blob.bin", headers={"Destination": f"http://127.0.0.1:18080{base}/FromDav/renamed.bin"})
    check("WebDAV can rename", c in (200, 201, 204), f"{c} {b}")
    c, b = lu.req("DELETE", base + "/FromDav/renamed.bin")
    check("WebDAV can delete", c in (200, 204), f"{c} {b}")
    c, b = Luna(18080).req("PROPFIND", base + "/", b"", headers={"Depth": "0"})
    check("WebDAV needs a sign-in", c == 401, f"{c} {b}")
    c, b = sam.req("PROPFIND", base + "/", b"", headers={"Depth": "0"})
    check("WebDAV hides a drive the member has no share on", c in (403, 404, 207) and not (c == 207 and "Docs" in str(b)), f"{c} {str(b)[:200]}")


def drive_state(lu, drive_id):
    r = drive_row(lu, drive_id)
    return r["state"] if r else None


def wait_state(lu, drive_id, want, timeout=40):
    end = time.time() + timeout
    st = None
    while time.time() < end:
        lu.get("/api/v1/drives/detected")  # the web app polls this; it reconciles drive state
        st = drive_state(lu, drive_id)
        if st == want:
            return True
        time.sleep(2)
    say(f"    (state is {st!r}, wanted {want!r})")
    return False


def copy_fixture(fx, kind, name):
    dst = f"{WORK}/fx/{name}.img"
    shutil.copy(fx[kind], dst)
    return dst


def part_drive_lifecycle(vm, lu, fx):
    say("-- drive lifecycle: exactly-one-file adoption, eject, replug, pull without eject")
    img = copy_fixture(fx, "fat32", "life")
    before = image_root_listing("fat32", img)
    d = plug(vm, lu, "u-life", img)
    check("[life] stick shows up", d is not None)
    if not d:
        return
    c, b = lu.post(f"/api/v1/drives/{d['name']}/adopt", {"label": "Life", "erase": False})
    check("[life] stick is added", c == 200, f"{c} {b}")
    did = b.get("id")
    c, b = lu.post(f"/api/v1/drives/{did}/eject")
    if c != 200:
        rc, o = vm.sh("for p in /proc/[0-9]*; do n=$(cat $p/comm 2>/dev/null); for l in $p/fd/* $p/cwd; do t=$(readlink $l 2>/dev/null); case \"$t\" in *mounts/drives*) echo \"$n ${p#/proc/} $l -> $t\";; esac; done; done 2>/dev/null | head -20; cat /proc/mounts | grep drives")
        say(f"    holders of the drive right after adding it:\n{o}")
        t0 = time.time()
        while c != 200 and time.time() - t0 < 60:
            time.sleep(3)
            c, b = lu.post(f"/api/v1/drives/{did}/eject")
        say(f"    eject succeeded after another {time.time() - t0:.0f}s" if c == 200 else "    eject never succeeded")
    check("[life] eject says it is safe", c == 200 and b.get("ok") is True, f"{c} {b}")
    check("[life] state is ejected", drive_state(lu, did) == "ejected")
    after = image_root_listing("fat32", img)
    added = sorted(set(after) - set(before))
    gone = sorted(set(before) - set(after))
    check("[life] adopting added only Luna's own hidden .luna- items (one database), and removed nothing",
          added and all(a.startswith(".luna-") for a in added) and sum(a.endswith(".sqlite3") for a in added) == 1 and not gone,
          f"added={added} gone={gone}")
    c, b = lu.get(f"/api/v1/drives/{did}/files")
    check("[life] an ejected drive's files answer with a plain message, not a crash", c in (404, 409, 423, 503) and isinstance(b, dict) and b.get("error"), f"{c} {b}")
    # still plugged in: stays ejected
    check("[life] it stays ejected while still plugged in", wait_state(lu, did, "ejected", 8))
    # unplug, replug
    check("[life] unplugging is noticed", unplug(vm, lu, "u-life", d["name"]))
    check("[life] state becomes missing", wait_state(lu, did, "missing"))
    t0 = time.time()
    c, b = lu.get(f"/api/v1/drives/{did}/files")
    check("[life] a missing drive answers calmly and fast", time.time() - t0 < 10 and c in (404, 409, 423, 503) and isinstance(b, dict) and b.get("error"), f"{c} {b} {time.time() - t0:.1f}s")
    d2 = plug(vm, lu, "u-life2", img) if False else None
    vm.usb_add("u-life2", img)
    check("[life] replugging brings the drive back to ready", wait_state(lu, did, "as_is", 60))
    c, ls = file_names(lu, did)
    check("[life] its files are there again", c == 200 and "hello.txt" in ls and "Photos" in ls, str(ls))
    # pull without eject
    vm.usb_del("u-life2")
    check("[life] pulling without eject is noticed", wait_state(lu, did, "missing", 40))
    c, b = lu.get(f"/api/v1/drives/{did}/summary")
    check("[life] the summary of a missing drive answers plainly", (c == 200 and b.get("mounted") is False) or (c in (404, 409) and isinstance(b, dict) and b.get("error")), f"{c} {b}")
    vm.usb_add("u-life3", img)
    check("[life] and it comes back again", wait_state(lu, did, "as_is", 60))
    c, ls = file_names(lu, did)
    check("[life] still intact after an unclean pull", c == 200 and "hello.txt" in ls, str(ls))
    # remove from Luna
    c, b = lu.post(f"/api/v1/drives/{did}/remove")
    check("[life] a drive can be removed from Luna", c == 200, f"{c} {b}")
    check("[life] a removed drive is offered in Add drive again", detected(lu, lambda x: True, 30) != [])
    vm.usb_del("u-life3")
    time.sleep(2)


def part_foreign_drives(vm, lu, fx):
    say("-- blank, damaged and other-format drives")
    for kind in ("blank", "corrupt"):
        img = copy_fixture(fx, kind, kind + "-t")
        d = plug(vm, lu, f"u-{kind}", img)
        check(f"[{kind}] shows up", d is not None)
        if not d:
            continue
        c, b = lu.get(f"/api/v1/drives/{d['name']}/peek")
        show(f"{kind} peek", (c, b))
        check(f"[{kind}] preview says it cannot be read or needs erasing", c == 200 and (b.get("needs_erase") or not b.get("readable")), f"{c} {b}")
        c2, b2 = lu.post(f"/api/v1/drives/{d['name']}/inspect")
        show(f"{kind} inspect", (c2, b2))
        c, b = lu.post(f"/api/v1/drives/{d['name']}/adopt", {"label": f"Fresh {kind}", "erase": False})
        check(f"[{kind}] adding without erasing is refused with a plain message", c == 400 and isinstance(b, dict) and "erase" in b.get("error", "").lower(), f"{c} {b}")
        pre = sh(f"sha256sum {img}").split()[0]
        c, b = lu.post(f"/api/v1/drives/{d['name']}/adopt", {"label": f"Fresh {kind}", "erase": True})
        check(f"[{kind}] adding with erase works", c == 200 and b.get("id"), f"{c} {b}")
        if c == 200:
            did = b["id"]
            data = os.urandom(50_000)
            c, b, _ = upload(lu, did, "after-erase.bin", data)
            check(f"[{kind}] the erased drive takes an upload", c == 200, f"{c} {b}")
            c, got = download(lu, did, "after-erase.bin")
            check(f"[{kind}] and gives it back", c == 200 and got == data)
            c, b = lu.post(f"/api/v1/drives/{did}/eject")
            check(f"[{kind}] eject works", c == 200, f"{c} {b}")
            out = sh(f"file -s {img} 2>/dev/null; blkid {img} 2>/dev/null; dumpe2fs -h {img} 2>&1 | head -3", check_rc=False)
            check(f"[{kind}] the drive now has a partition with a filesystem", "ID=0x7" in out or "ID=0xc" in out or "ID=0xb" in out or "ext" in out.lower() or "fat" in out.lower(), out[:200])
            say(f"    filesystem made: {out.strip().splitlines()[:2]}")
        unplug(vm, lu, f"u-{kind}", d["name"])
    for kind in ("exfat", "ntfs"):
        img = copy_fixture(fx, kind, kind + "-t")
        d = plug(vm, lu, f"u-{kind}", img)
        check(f"[{kind}] shows up", d is not None)
        if not d:
            continue
        c, b = lu.get(f"/api/v1/drives/{d['name']}/peek")
        check(f"[{kind}] preview reads the drive", c == 200 and b.get("readable") and b.get("fs_type"), f"{c} {b}")
        c, b = lu.post(f"/api/v1/drives/{d['name']}/adopt", {"label": f"My {kind}", "erase": False})
        check(f"[{kind}] drive is added", c == 200 and b.get("id"), f"{c} {b}")
        if c == 200:
            did = b["id"]
            data = os.urandom(300_000)
            c, b, _ = upload(lu, did, "big file \u00e9.bin", data)
            check(f"[{kind}] upload with a non-ASCII name", c == 200, f"{c} {b}")
            c, got = download(lu, did, "big file \u00e9.bin")
            check(f"[{kind}] and gives it back", c == 200 and got == data)
            c, b = lu.post(f"/api/v1/drives/{did}/files/mkdir", {"path": "Sub"})
            check(f"[{kind}] folders work", c in (200, 201), f"{c} {b}")
            c, b = lu.post(f"/api/v1/drives/{did}/eject")
            check(f"[{kind}] eject works", c == 200, f"{c} {b}")
            if kind == "exfat":
                r = sh(f"fsck.exfat -n {img}; echo rc=$?", check_rc=False)
                check("[exfat] the filesystem is clean after eject", "rc=0" in r, r[-200:])
            else:
                r = sh(f"ntfsfix -n {img} 2>&1; echo rc=$?", check_rc=False)
                check("[ntfs] the filesystem is clean after eject", "rc=0" in r, r[-300:])
        unplug(vm, lu, f"u-{kind}", d["name"])


def fsck_data(raw):
    """Repair-check LUNA_DATA on a flattened copy the way boot would (journal replay)."""
    off, size, _ = parts(raw)[5]
    img = f"{WORK}/data-fsck.img"
    sh(f"dd if={raw} of={img} bs=1M skip={off // 1048576} count={size // 1048576} 2>/dev/null")
    r = sh(f"e2fsck -fp {img}; echo rc=$?", check_rc=False)
    os.unlink(img)
    m = re.search(r"rc=(\d+)", r)
    return (int(m.group(1)) if m else 99), r


def bring_up(name, usb=None, port=18080, **kw):
    vm = golden_vm(name, "sata", xhci=True, port=port, **kw)
    lu = Luna(port)
    if usb:
        vm.usb_add("u-boot", usb)
    return vm, lu


def login_admin(lu):
    c, b = lu.post("/api/v1/auth/login", {"username": ADMIN["username"], "password": ADMIN["password"]})
    return c == 200


def stage_resilience():
    """Crashes, restarts, power cuts, a missing cable, a full disk, a wrong clock."""
    say("-- resilience")
    fx = make_fixtures()
    img = copy_fixture(fx, "ext4", "resil")
    vm, lu = bring_up("resil", usb=img)
    check("web UI answers", lu.wait_up(240))
    lu.post("/api/v1/auth/register", ADMIN)
    check("admin signs in", login_admin(lu))
    lu.post("/api/v1/setup", {"setup_completed": True, "current_step": "done"})
    d = detected(lu, lambda x: True, 60)
    check("the stick plugged at boot is offered", bool(d))
    c, b = lu.post(f"/api/v1/drives/{d[0]['name']}/adopt", {"label": "Resil", "erase": False})
    did = b.get("id")
    check("added", c == 200 and did, f"{c} {b}")
    data = os.urandom(2_000_000)
    c, b, _ = upload(lu, did, "keep.bin", data)
    check("a file is stored", c == 200, f"{c} {b}")

    # -- lunad crash
    rc, o = vm.sh("kill -9 $(pidof lunad)")
    t0 = time.time()
    time.sleep(2)
    up = lu.wait_up(60)
    check("lunad is restarted by itself within a minute after a crash", up, f"{time.time() - t0:.0f}s")
    say(f"    back after {time.time() - t0:.0f}s")
    c, b = lu.get("/api/v1/auth/me")
    check("the crash did not sign anyone out", c == 200 and b and b.get("role") == "admin", f"{c} {b}")
    c, got = download(lu, did, "keep.bin")
    check("the stored file is still fine after the crash", c == 200 and got == data)

    # -- a crash loop must not make the supervisor give up
    for i in range(12):
        vm.sh("kill -9 $(pidof lunad) 2>/dev/null; true")
        time.sleep(3)
    check("lunad keeps being restarted after a dozen crashes in a minute", lu.wait_up(60))

    # -- clean reboot from the guest
    vm.sh("sync")
    vm.serial_send("reboot\n")
    check("Luna goes down for a reboot", True)
    check("Luna comes back after a reboot", wait_reboot_up(vm, lu, 240))
    check("admin can sign in after the reboot", login_admin(lu))
    check("the drive is back to ready by itself after a reboot", wait_state(lu, did, "as_is", 60))
    c, got = download(lu, did, "keep.bin")
    check("the file survived the reboot", c == 200 and got == data)
    rc, o = vm.sh("cat /proc/cmdline")
    check("reboot kept the same slot", "luna.slot=A" in o, o)
    # the stick stays plugged in across several restarts, together with a second one
    img2 = copy_fixture(fx, "fat32", "resil2")
    d2 = plug(vm, lu, "u-resil2", img2)
    c, b = lu.post(f"/api/v1/drives/{d2['name']}/adopt", {"label": "Second", "erase": False}) if d2 else (0, {})
    did2 = b.get("id")
    check("a second stick is added", c == 200 and did2, f"{c} {b}")
    for n in (1, 2, 3):
        vm.serial_send("sync; reboot\n")
        check(f"[restart {n}] Luna comes back", wait_reboot_up(vm, lu, 240))
        check(f"[restart {n}] admin can sign in", login_admin(lu))
        ok1 = wait_state(lu, did, "as_is", 60)
        ok2 = wait_state(lu, did2, "as_is", 60)
        if not (ok1 and ok2):
            rc, o = vm.sh("tail -n 25 /var/lib/luna/logs/luna.log | cut -c1-250")
            say("    log:\n" + o)
        check(f"[restart {n}] both sticks are ready again with no one touching anything", ok1 and ok2)
    c, got = download(lu, did, "keep.bin")
    check("the file is still right after three restarts", c == 200 and got == data)

    # -- power cut in the middle of an upload
    import threading
    srcfile = f"{WORK}/cut-src.bin"
    sh(f"head -c 120000000 /dev/urandom > {srcfile}")
    state = {"chunks": 0}

    def go():
        total = os.path.getsize(srcfile)
        c, b = lu.post("/api/v1/uploads", {"drive_id": did, "path": "", "name": "cut.bin", "size": total})
        uid = b.get("upload_id")
        off = 0
        with open(srcfile, "rb") as f:
            while off < total:
                data = f.read(2_000_000)
                c, r = lu.req("PUT", f"/api/v1/uploads/{uid}", data, headers={"Content-Range": f"bytes {off}-{off + len(data) - 1}/{total}", "Content-Type": "application/octet-stream"}, timeout=20)
                if c != 200:
                    state["err"] = c
                    return
                off += len(data)
                state["chunks"] += 1

    th = threading.Thread(target=go)
    th.start()
    while state["chunks"] < 25 and th.is_alive():
        time.sleep(0.05)
    vm.kill()
    th.join(60)
    check("the upload was cut part-way by the power cut", state["chunks"] >= 25 and state.get("err") is not None, str(state))
    raw = overlay_to_raw("resil")
    rc_, out = fsck_data(raw)
    check("after a power cut the data partition repairs cleanly", rc_ in (0, 1), out[-300:])
    ov = f"{WORK}/resil.qcow2"
    vm = VM("resil2", [{"file": ov, "fmt": "qcow2", "bus": "sata", "bootindex": 0}, {"file": img, "bus": "usb"}],
            http_port=18080, xhci=True)
    vm.start()
    lu = Luna(18080)
    check("Luna boots after a power cut", lu.wait_up(240))
    check("admin can sign in after a power cut", login_admin(lu))
    ok = wait_state(lu, did, "as_is", 90)
    if not ok:
        rc, o = vm.sh("tail -n 30 /var/lib/luna/logs/luna.log | cut -c1-250; cat /proc/mounts | grep -E 'sd[b-z]'; dmesg | tail -15")
        say("    after the power cut:\n" + o)
    check("the drive is ready after a power cut", ok)
    c, got = download(lu, did, "keep.bin")
    check("the file stored before the cut is intact", c == 200 and got == data)
    c, ls = file_names(lu, did)
    check("the half-written upload is not shown as a file", "cut.bin" not in ls, str(ls))
    # resume
    c, b, uid, h = upload_file(lu, did, "cut.bin", srcfile)
    check("the same upload can be started again and finishes", c == 200, f"{c} {b}")
    dest = f"{WORK}/cut-down.bin"
    c, hd = download_to(lu, did, "cut.bin", dest)
    check("and the file is right", c == 200 and hd == h)
    os.unlink(dest)
    rc, o = vm.sh("cat /proc/cmdline")
    check("power cut kept the same slot", "luna.slot=A" in o, o)

    # -- no cable
    rc, o = vm.sh("ip -4 addr show eth0 | grep -c inet")
    check("Luna has an address before the cable is pulled", o.strip() == "1", o)
    vm.hmp("set_link n0 off")
    time.sleep(10)
    rc, o = vm.sh("cat /sys/class/net/eth0/carrier")
    check("the guest sees the cable as pulled", o.strip() == "0", o)
    c, b = lu.get("/api/v1/health", timeout=5)
    say(f"    health with cable out (via hostfwd): {c}")
    rc, o = vm.sh("curl -sS -m 5 http://127.0.0.1/api/v1/health 2>&1; echo curl-rc=$?; ip -4 addr; ip link show lo")
    check("Luna itself keeps running without a cable", '"status":"ok"' in o, o)
    vm.hmp("set_link n0 on")
    ok = False
    for _ in range(40):
        time.sleep(3)
        rc, o = vm.sh("ip -4 addr show eth0 | grep -c 'inet '")
        if o.strip() == "1":
            ok = True
            break
    check("plugging the cable back in gets an address again (within 2 min)", ok)
    check("and the web UI is reachable again", lu.wait_up(60))
    rc, o = vm.sh("cat /var/lib/luna/issue")
    check("the console notes show the address again", re.search(r"\d+\.\d+\.\d+\.\d+", o) is not None, o)
    rc, o = vm.sh("cat /etc/resolv.conf")
    check("name lookup still configured", "nameserver" in o, o)

    # -- full data partition
    rc, o = vm.sh("df -k /var/lib/luna | tail -1")
    free_kb = int(o.split()[3])
    rc, o = vm.sh(f"fallocate -l {max(free_kb - 2048, 1) * 1024} /var/lib/luna/FILLER 2>&1; df -k /var/lib/luna | tail -1")
    say(f"    data partition after filler: {o}")
    c, b = lu.post("/api/v1/auth/login", {"username": ADMIN["username"], "password": ADMIN["password"]})
    check("signing in still works when Luna's own storage is nearly full", c == 200, f"{c} {b}")
    c, b = lu.get("/api/v1/health")
    check("health still answers", c == 200, f"{c} {b}")
    c, b = lu.get("/api/v1/system/health/check")
    show("health check", (c, str(b)[:400]))
    rc, o = vm.sh("rm -f /var/lib/luna/FILLER; sync; df -k /var/lib/luna | tail -1")
    c, b = lu.get("/api/v1/drives")
    check("everything works again after space is freed", c == 200, f"{c} {b}")
    vm.sh("sync")
    vm.quit()


def stage_installer_prod(fw="bios"):
    """The installer exactly as a person meets it: stick -> firmware -> GRUB -> prompts -> reboot."""
    say(f"-- real-world installer path ({fw})")
    disk = f"{WORK}/prod-{fw}.raw"
    blank_disk(disk)
    stick = f"{WORK}/stick-ro.iso"
    if not os.path.exists(stick):
        shutil.copy(ISO, stick)
    vm = VM(f"prod-{fw}", [{"file": stick, "bus": "usb", "readonly": True, "bootindex": 0},
                           {"file": disk, "bus": "sata", "bootindex": 1}],
            firmware=fw, mem=2048, extra=["-no-reboot"])
    vm.start()
    check(f"[{fw}] firmware finds the stick and GRUB shows the installer", vm.wait_screen(r"rapidinstall|Luna", 120))
    ok = vm.wait_screen(r"Do nothing for|Installing to", 180)
    check(f"[{fw}] installer announces the disk it will use and starts its countdown", ok)
    txt = vm.ocr(f"prod-{fw}-count")
    check(f"[{fw}] it names the built-in disk and not the stick", "/dev/sda" in txt and "Installing to /dev/sdb" not in txt, txt[-400:])
    check(f"[{fw}] the plain-language warning is on screen", "will be erased" in txt or "erase" in txt.lower(), txt[-400:])
    ok = vm.wait_screen(r"Type INSTALL|Confirm", 60)
    check(f"[{fw}] after the countdown it asks for INSTALL", ok)
    vm.type("INSTALL\n")
    check(f"[{fw}] it installs and says so", vm.wait_screen(r"Installation complete|Luna will reboot", 600))
    # The installer offers to take a Luna Connect device token; Enter on an empty field skips it.
    check(f"[{fw}] after unpacking it offers the optional device token step", vm.wait_screen(r"opt-out for now|device token", 600))
    vm.key("ret")
    exited = vm.wait_exit(300)
    if not exited:
        say("    screen when it should have restarted:\n" + vm.ocr(f"prod-{fw}-end").strip()[-700:])
    check(f"[{fw}] it restarts by itself when done (after unpacking the office editor)", exited)
    vm.quit()
    p = parts(disk)
    check(f"[{fw}] the disk has the five Luna partitions", sorted(p) == [1, 2, 3, 4, 5], str(p))
    # boot the result with no stick
    serial_console_for_tests(disk)
    point_at_mock_connect(disk)
    start_mock_connect()
    vm = boot_disk(f"prod-{fw}-run", disk, "sata", fw=fw)
    lu = Luna(18080)
    check(f"[{fw}] the installed Luna starts", lu.wait_up(240))
    check(f"[{fw}] it runs from slot A", slot_of(vm) == "A")
    c, b = lu.get("/api/v1/auth/status")
    check(f"[{fw}] and shows the first-run setup", c == 200 and b.get("has_admin") is False, f"{c} {b}")
    vm.sh("sync")
    vm.quit()


def stage_installer_prod_bios():
    stage_installer_prod("bios")


def stage_installer_prod_uefi():
    stage_installer_prod("uefi")


def stage_installer_prompts():
    """Wrong answers and the disk picker, on real firmware."""
    say("-- installer prompts")
    stick = f"{WORK}/stick-ro.iso"
    if not os.path.exists(stick):
        shutil.copy(ISO, stick)
    a, b = f"{WORK}/prompt-a.raw", f"{WORK}/prompt-b.raw"
    blank_disk(a, 7)
    blank_disk(b, 9)
    vm = VM("prompts", [{"file": stick, "bus": "usb", "readonly": True, "bootindex": 0},
                        {"file": b, "bus": "sata"}, {"file": a, "bus": "sata"}],
            firmware="bios", mem=2048, extra=["-no-reboot"])
    vm.start()
    # The countdown is five seconds and reading the screen takes about three, so press
    # right away, repeatedly, and only then look at what the screen says.
    seen = vm.wait_screen(r"Installing to /dev/sd[a-d] \(7168", 180, interval=1)
    for _ in range(12):
        vm.key("spc")
        time.sleep(0.4)
    check("two internal disks: the installer picks the smaller one", seen)
    check("pressing a key opens the numbered disk list", vm.wait_screen(r"Press a number|Number:", 60))
    txt = vm.ocr("prompts-2")
    # (kernel names depend on probe order; the sizes tell the two built-in disks apart)
    check("the list names both internal disks", "7168" in txt and "9216" in txt, txt[-500:])
    vm.key("1")
    check("after choosing, it asks for confirmation", vm.wait_screen(r"Type INSTALL|Confirm", 60))
    vm.type("install\n")
    check("anything but INSTALL shuts the computer down", vm.wait_exit(90))
    vm.quit()
    check("and nothing was erased", is_zero(a, 0, 64 * 1048576) and is_zero(b, 0, 64 * 1048576))


def stage_matrix():
    """Real disks and firmware: SATA, NVMe, eMMC and virtio, each booted by BIOS and UEFI."""
    say("-- hardware matrix")
    # (eMMC under UEFI is left out: QEMU's OVMF cannot boot from an emulated SD card at all,
    # which says nothing about real firmware. eMMC under BIOS covers the disk driver.)
    combos = [("sata", "uefi"), ("nvme", "bios"), ("nvme", "uefi"), ("mmc", "bios"), ("virtio", "bios")]
    for bus in sorted({b for b, _ in combos}):
        if not os.path.exists(f"{WORK}/golden-{bus}.raw"):
            stage_install(bus, "bios")
    for bus, fw in combos:
        T = f"[{bus}/{fw}] "
        vm = golden_vm(f"mx-{bus}-{fw}", bus, fw=fw)
        lu = Luna(18080)
        up = lu.wait_up(240)
        check(T + "Luna starts", up)
        if not up:
            say(vm.serial_text()[-1500:])
            vm.quit()
            continue
        time.sleep(5)
        rc, o = vm.sh("mount | grep ' / '")
        want = {"sata": "/dev/sda3", "nvme": "/dev/nvme0n1p3", "mmc": "/dev/mmcblk0p3", "virtio": "/dev/vda3"}[bus]
        check(T + f"the system root is {want}", want in o, o)
        check(T + "it runs from slot A", slot_of(vm) == "A")
        rc, o = vm.sh("cat /run/luna/boot-ok >/dev/null && echo yes")
        check(T + "the boot was confirmed", "yes" in o, o)
        rc, o = vm.sh("rc-status -a | grep -c crashed")
        check(T + "no service crashed", o.strip().endswith("0"), o)
        c, b = lu.get("/api/v1/health")
        check(T + "Luna's health answer is ok", c == 200 and b.get("status") == "ok", f"{c} {str(b)[:300]}")
        rc, o = vm.sh("dmesg | grep -i -E 'error|fail' | grep -v -i -E 'ACPI|firmware|apparmor' | head -8")
        check(T + "no kernel errors", o.strip() == "", o)
        # SMART/health of the system disk shouldn't hang the box
        vm.hmp("system_powerdown")
        check(T + "ACPI power button shuts it down cleanly within 60 s", vm.wait_exit(60))
        vm.quit()


def make_media():
    """A JPEG with date and GPS, a PNG, a HEIC from a phone, a short video, and a text file."""
    from PIL import Image, ImageDraw
    import pillow_heif
    pillow_heif.register_heif_opener()
    d = f"{WORK}/media"
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)

    def pic(color, text):
        im = Image.new("RGB", (1600, 1200), color)
        ImageDraw.Draw(im).text((100, 100), text, fill=(255, 255, 255))
        return im

    def exif(dt, lat=None, lon=None):
        # Pillow's own writer: a hand-dumped block trips strict readers ("Unexpected next IFD").
        ex = Image.Exif()
        ex[0x010F] = "E2E"
        ex[0x0110] = "TestCam 1"
        ex.get_ifd(0x8769)[0x9003] = dt
        if lat is not None:
            g = ex.get_ifd(0x8825)
            g[1] = "N"
            g[2] = (int(lat), int((lat % 1) * 60), 0.0)
            g[3] = "E"
            g[4] = (int(lon), int((lon % 1) * 60), 0.0)
        return ex.tobytes()

    pic((200, 60, 60), "beach").save(f"{d}/beach.jpg", exif=exif("2020:07:04 12:30:00", 52.52, 13.40))
    pic((60, 200, 60), "forest").save(f"{d}/forest.png")
    heic = pic((60, 60, 200), "phone")
    heic.save(f"{d}/IMG_0001.HEIC", exif=exif("2021:01:02 09:00:00"))
    sh(f"ffmpeg -loglevel error -f lavfi -i testsrc=duration=2:size=320x240:rate=15 -pix_fmt yuv420p {d}/clip.mp4")
    open(f"{d}/notes.txt", "w").write("not a photo\n")
    return d


def part_gallery(vm, lu, drive):
    say("-- photos")
    D = drive
    media = make_media()
    lu.post(f"/api/v1/drives/{D}/files/mkdir", {"path": "Pictures"})
    for name in sorted(os.listdir(media)):
        data = open(f"{media}/{name}", "rb").read()
        c, b, _ = upload(lu, D, name, data, path="Pictures", chunk=1_000_000)
        check(f"[photos] upload {name}", c == 200, f"{c} {b}")
    # the scanner runs by itself
    end = time.time() + 180
    while time.time() < end:
        c, st = lu.get("/api/v1/gallery/status")
        if isinstance(st, dict) and not st.get("busy") and st.get("pending", 0) == 0:
            break
        time.sleep(3)
    end = time.time() + 30
    items = []
    while time.time() < end:
        c, b = lu.get("/api/v1/gallery")
        items = b.get("items") if isinstance(b, dict) else (b if isinstance(b, list) else [])
        if items and len(items) >= 4:
            break
        time.sleep(3)
    show("gallery", (c, str(b)[:600]))
    names = sorted((i.get("name") or i.get("path") or "") for i in items or [])
    say(f"    gallery items: {names}")
    check("[photos] the gallery lists the JPEG, PNG, HEIC and video", len(items or []) >= 4, str(names))
    check("[photos] the text file is not in the gallery", not any("notes.txt" in n for n in names), str(names))
    c, st = lu.get("/api/v1/gallery/status")
    show("gallery status", (c, st))
    c, pl = lu.get("/api/v1/gallery/places")
    show("places", (c, str(pl)[:300]))
    check("[photos] the geotagged photo shows up in Places", c == 200 and "52" in json.dumps(pl), str(pl)[:300])
    c, cams = lu.get("/api/v1/gallery/cameras")
    check("[photos] the camera model is known", c == 200 and "TestCam" in json.dumps(cams), str(cams)[:300])
    beach = next((i for i in items or [] if "beach" in json.dumps(i)), None)
    say(f"    beach.jpg as the gallery knows it: {json.dumps(beach)[:700]}")
    for it in items or []:
        nm = it.get("name") or it.get("path") or ""
        if not (it.get("path") or "").startswith("Pictures/"):
            continue
        key = it.get("id") or it.get("key") or it.get("ref")
        q = f"drive_id={quote(it.get('drive_id', D))}&path={quote(it.get('path', ''))}"
        c, th = lu.get(f"/api/v1/gallery/thumb?{q}", raw=True)
        check(f"[photos] preview for {nm}", c == 200 and len(th) > 200 and th[:2] == b"\xff\xd8", f"{c} {len(th) if th else 0} {q}")


def upload_file(lu, drive, name, src, path="", chunk=8 * 1024 * 1024, stop_at=None, timeout=120, resume=None):
    """Stream a big file up in chunks like the web app. Returns (status, body, upload_id, hash-or-offset).

    resume=(upload_id, offset) carries on an upload this client already opened, the way the
    browser does after a dropped connection; when stopped on purpose the 4th item is the offset.
    """
    total = os.path.getsize(src)
    if resume:
        uid, off = resume
    else:
        c, b = lu.post("/api/v1/uploads", {"drive_id": drive, "path": path, "name": name, "size": total})
        if c != 200:
            return c, b, None, None
        uid = b["upload_id"]
        off = b.get("received", 0)
    h = blake3.blake3()
    with open(src, "rb") as f:
        # the hash covers the whole file even when the upload resumes part-way
        pos = 0
        while pos < off:
            n = min(chunk, off - pos)
            h.update(f.read(n))
            pos += n
        while off < total:
            data = f.read(min(chunk, total - off))
            c, r = lu.req("PUT", f"/api/v1/uploads/{uid}", data,
                          headers={"Content-Range": f"bytes {off}-{off + len(data) - 1}/{total}", "Content-Type": "application/octet-stream"},
                          timeout=timeout)
            if c != 200:
                return c, r, uid, None
            h.update(data)
            off += len(data)
            if stop_at and off >= stop_at:
                return 0, "stopped on purpose", uid, off
    c, r = lu.post(f"/api/v1/uploads/{uid}/complete?hash={h.hexdigest()}", timeout=600)
    return c, r, uid, h.hexdigest()


def download_to(lu, drive, path, dest, rng=None):
    h = {"Range": rng} if rng else {}
    r = urllib.request.Request(lu.base + f"/api/v1/drives/{drive}/files/content?path={quote(path)}&download=1", headers=h)
    hs = blake3.blake3()
    with lu.op.open(r, timeout=300) as resp, open(dest, "wb") as out:
        while True:
            b = resp.read(1 << 20)
            if not b:
                break
            out.write(b)
            hs.update(b)
        return resp.status, hs.hexdigest()


def hash_file(path, start=0, length=None):
    h = blake3.blake3()
    with open(path, "rb") as f:
        f.seek(start)
        left = length
        while True:
            n = 1 << 20 if left is None else min(1 << 20, left)
            if n == 0:
                break
            b = f.read(n)
            if not b:
                break
            h.update(b)
            if left is not None:
                left -= len(b)
    return h.hexdigest()


def stage_bigfiles():
    """A 2 GB file in chunks, resumed after the cable was pulled; a full drive; space freed again."""
    say("-- big files")
    big = f"{WORK}/fx/big.img"
    os.makedirs(f"{WORK}/fx", exist_ok=True)
    sh(f"rm -f {big}; truncate -s 3500M {big}; mke2fs -q -t ext4 -m 0 -L BIGDRIVE {big}")
    src = f"{WORK}/big-src.bin"
    if not os.path.exists(src) or os.path.getsize(src) != 2 * 1024**3 + 12345:
        say("    making a 2 GiB test file")
        sh(f"head -c {2 * 1024**3 + 12345} /dev/urandom > {src}")
    vm, lu = bring_up("big", usb=big)
    check("web UI answers", lu.wait_up(240))
    lu.post("/api/v1/auth/register", ADMIN)
    check("admin signs in", login_admin(lu))
    lu.post("/api/v1/setup", {"setup_completed": True, "current_step": "done"})
    d = detected(lu, lambda x: True, 60)
    c, b = lu.post(f"/api/v1/drives/{d[0]['name']}/adopt", {"label": "Big", "erase": False})
    D = b.get("id")
    check("the 3.5 GB drive is added", c == 200 and D, f"{c} {b}")
    c, b = lu.get(f"/api/v1/drives/{D}/summary")
    free0 = b.get("free_bytes") if isinstance(b, dict) else None
    say(f"    free before: {free0}")
    total = os.path.getsize(src)
    t0 = time.time()
    c, b, uid, off = upload_file(lu, D, "big.bin", src, stop_at=total * 4 // 10)
    check("2 GB upload: first 40% goes up", c == 0, f"{c} {b}")
    # the cable is pulled mid-upload: the next chunk gets nowhere
    vm.hmp("set_link n0 off")
    chunk = open(src, "rb").read(1_000_000) if False else b"x" * 1000
    c, r = lu.req("GET", "/api/v1/health", timeout=6)
    check("with the cable pulled the browser sees a failure, not a hang", c != 200, f"{c}")
    time.sleep(5)
    vm.hmp("set_link n0 on")
    check("the cable is back and Luna answers", lu.wait_up(120))
    c, b, uid2, h = upload_file(lu, D, "big.bin", src, resume=(uid, off))
    check("the same upload carries on where it stopped and completes", c == 200, f"{c} {b}")
    say(f"    2 GB up in {time.time() - t0:.0f}s total (including the pause)")
    dest = f"{WORK}/big-down.bin"
    t0 = time.time()
    c, hd = download_to(lu, D, "big.bin", dest)
    say(f"    2 GB down in {time.time() - t0:.0f}s")
    check("2 GB download matches the original byte for byte", c == 200 and hd == h, f"{c}")
    os.unlink(dest)
    # a range that starts past 2 GiB
    off = 2 * 1024**3 + 100
    c, hd = download_to(lu, D, "big.bin", dest, rng=f"bytes={off}-{off + 999}")
    check("a range request past 2 GiB returns the right bytes", c == 206 and hd == hash_file(src, off, 1000), f"{c}")
    os.unlink(dest)
    c, b = lu.get(f"/api/v1/drives/{D}/summary")
    free1 = b.get("free_bytes")
    check("free space dropped by about the file size", free0 and free1 and 1.9e9 < free0 - free1 < 2.4e9, f"{free0} -> {free1}")
    # a file bigger than what is left
    c, b, bigid, _ = upload_file(lu, D, "toobig.bin", src)
    check("a file bigger than the free space is refused plainly", c in (400, 413, 507) and isinstance(b, dict) and b.get("error"), f"{c} {b}")
    if isinstance(b, dict):
        say(f"    message: {b.get('error')}")
    c, ls = file_names(lu, D)
    check("and leaves no half-written file behind", c == 200 and "toobig.bin" not in ls, str(ls))
    check("a drive that ran out of room is not called read-only", drive_state(lu, D) == "as_is", str(drive_state(lu, D)))
    if bigid:
        c, b = lu.req("DELETE", f"/api/v1/uploads/{bigid}")
        check("the browser can cancel the failed upload to give its space back", c in (200, 204), f"{c} {b}")
    # fill the drive to the brim with a file that fits, then try a small one
    c, b = lu.get(f"/api/v1/drives/{D}/summary")
    left = b.get("free_bytes")
    fillsrc = f"{WORK}/fill.bin"
    sh(f"head -c {max(left - 300_000, 1)} /dev/zero > {fillsrc}")
    c, b, _, _ = upload_file(lu, D, "fill.bin", fillsrc)
    check("a file that just fits is accepted", c == 200, f"{c} {b}")
    c, b, _ = upload(lu, D, "one-more.bin", os.urandom(2_000_000))
    check("when the drive is full the next upload says so plainly", c in (400, 413, 507) and isinstance(b, dict) and "full" in str(b.get("error", "")).lower(), f"{c} {b}")
    c, ls = file_names(lu, D)
    check("and leaves no partial file", "one-more.bin" not in ls, str(ls))
    # delete frees space
    for nm in ("fill.bin", "big.bin"):
        c, b = lu.req("DELETE", f"/api/v1/drives/{D}/files?path={quote(nm)}")
        check(f"delete {nm}", c == 200, f"{c} {b}")
    c, tr = lu.get(f"/api/v1/drives/{D}/files?path=.luna-trash")
    show("trash", (c, str(tr)[:300]))
    for it in tr if isinstance(tr, list) else []:
        c, b = lu.post(f"/api/v1/drives/{D}/files/purge", {"path": f".luna-trash/{it['name']}"})
        show("purge", (c, b))
    time.sleep(3)
    c, b = lu.get(f"/api/v1/drives/{D}/summary")
    check("emptying the trash gives the space back", c == 200 and b.get("free_bytes", 0) > 3.0e9, str(b))
    os.unlink(fillsrc)
    vm.sh("sync")
    vm.quit()


def wait_job(lu, job_id, timeout=120):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        c, b = lu.get(f"/api/v1/jobs/{job_id}")
        last = b
        if c == 200 and isinstance(b, dict) and b.get("state") in ("done", "failed", "error", "cancelled", "finished", "complete"):
            return b
        time.sleep(1)
    return last


def stage_app():
    """Everything a person does after setup: search, copy/move, trash, backups, tokens, Connect, assets, reset."""
    say("-- app features")
    fx = make_fixtures()
    a_img = copy_fixture(fx, "ext4", "app-a")
    b_img = copy_fixture(fx, "ext4", "app-b")
    vm, lu = bring_up("app", usb=a_img)
    check("web UI answers", lu.wait_up(240))
    lu.post("/api/v1/auth/register", ADMIN)
    check("admin signs in", login_admin(lu))
    lu.post("/api/v1/setup", {"setup_completed": True, "current_step": "done", "name": "E2E Luna"})
    d = detected(lu, lambda x: True, 60)
    c, b = lu.post(f"/api/v1/drives/{d[0]['name']}/adopt", {"label": "Main", "erase": False})
    A = b.get("id")
    d2 = plug(vm, lu, "u-app-b", b_img)
    c, b = lu.post(f"/api/v1/drives/{d2['name']}/adopt", {"label": "Backup", "erase": False})
    B = b.get("id")
    check("two drives are added", bool(A and B), f"{A} {B}")
    c, bd = lu.get("/api/v1/drives")
    check("both drives list as ready", c == 200 and sorted(x["state"] for x in bd) == ["as_is", "as_is"], str(bd))

    # -- content
    lu.post(f"/api/v1/drives/{A}/files/mkdir", {"path": "Docs"})
    lu.post(f"/api/v1/drives/{A}/files/mkdir", {"path": "Docs/Taxes 2025"})
    texts = {"Docs/holiday plan.txt": b"flights to lisbon\n", "Docs/Taxes 2025/receipt.txt": b"receipt 42\n", "Docs/blob.bin": os.urandom(3_000_000)}
    for path, data in texts.items():
        folder, name = path.rsplit("/", 1)
        c, b, _ = upload(lu, A, name, data, path=folder)
        check(f"[app] upload {path}", c == 200, f"{c} {b}")
    # search
    time.sleep(3)
    c, b = lu.get("/api/v1/search?q=holiday")
    show("search", (c, str(b)[:300]))
    check("[app] search finds a file by part of its name", c == 200 and "holiday plan.txt" in json.dumps(b), str(b)[:300])
    c, b = lu.get("/api/v1/search?q=taxes&kind=dir")
    check("[app] search can look for folders only", c == 200 and "Taxes 2025" in json.dumps(b), str(b)[:300])
    c, b = lu.get("/api/v1/search?q=zzzznothing")
    check("[app] search with no match is an empty answer", c == 200, f"{c} {b}")
    # copy / move
    c, b = lu.post("/api/v1/jobs", {"kind": "copy", "from_drive": A, "from_path": "Docs", "to_drive": B, "to_path": ""})
    show("copy job", (c, b))
    check("[app] a copy to the other drive starts", c in (200, 201, 202), f"{c} {b}")
    jid = (b.get("id") or b.get("job_id")) if isinstance(b, dict) else None
    if jid:
        r = wait_job(lu, jid)
        show("job result", (200, r))
    c, ls = file_names(lu, B)
    check("[app] the copy arrived on the other drive", "Docs" in ls, str(ls))
    c, got = download(lu, B, "Docs/blob.bin")
    check("[app] and its big file is identical", c == 200 and got == texts["Docs/blob.bin"], f"{c}")
    c, b = lu.post("/api/v1/jobs", {"kind": "move", "from_drive": B, "from_path": "Docs/Taxes 2025", "to_drive": B, "to_path": ""})
    show("move job", (c, b))
    jid = (b.get("id") or b.get("job_id")) if isinstance(b, dict) else None
    if jid:
        show("move result", (200, wait_job(lu, jid)))
    c, ls = file_names(lu, B)
    c2, ls2 = file_names(lu, B, "Docs")
    check("[app] a move inside a drive works", "Taxes 2025" in ls and "Taxes 2025" not in ls2, f"root={ls} docs={ls2}")
    # trash
    c, b = lu.req("DELETE", f"/api/v1/drives/{A}/files?path={quote('Docs/holiday plan.txt')}")
    check("[app] delete sends a file to the trash", c == 200, f"{c} {b}")
    c, ls = file_names(lu, A, "Docs")
    check("[app] it's gone from the folder", "holiday plan.txt" not in ls, str(ls))
    c, tr = lu.get(f"/api/v1/drives/{A}/files?path={quote('.luna-trash')}")
    show("trash listing", (c, str(tr)[:300]))
    # protections (backup to the other drive)
    c, b = lu.post("/api/v1/protections", {"source_drive_id": A, "source_path": "Docs", "target_drive_id": B})
    show("create protection", (c, b))
    check("[app] a backup to the other drive can be set up", c in (200, 201), f"{c} {b}")
    pid = b.get("id") if isinstance(b, dict) else None
    if pid:
        c, b = lu.post(f"/api/v1/protections/{pid}/run")
        show("run protection", (c, b))
        check("[app] and it runs", c in (200, 202), f"{c} {b}")
        time.sleep(8)
        c, b = lu.get("/api/v1/protections")
        show("protections", (c, str(b)[:400]))
        check("[app] the backup reports it finished fine", c == 200 and all(x.get("state") == "ok" and not x.get("last_error") for x in b), str(b)[:300])
    # device tokens
    c, b = lu.post("/api/v1/device-tokens", {"name": "e2e laptop"})
    tok = b.get("token") if isinstance(b, dict) else None
    check("[app] an access token can be made", c in (200, 201) and tok, f"{c} {b}")
    if tok:
        import base64
        basic = "Basic " + base64.b64encode(f"admin:{tok}".encode()).decode()
        c, b = Luna(18080).req("PROPFIND", f"/dav/{A}/", b"", headers={"Authorization": basic, "Depth": "0"})
        check("[app] the token works for WebDAV like a desktop app would use it", c == 207, f"{c} {str(b)[:100]}")
        c, b = Luna(18080).get("/api/v1/drives", headers={"Authorization": f"Bearer {tok}"})
        check("[app] and as a bearer token for the API", c == 200, f"{c} {b}")
        c, b = lu.req("DELETE", f"/api/v1/device-tokens/{b and ''}") if False else (0, None)
        c, lst = lu.get("/api/v1/device-tokens")
        tid = next((t["id"] for t in lst if t.get("name") == "e2e laptop"), None) if isinstance(lst, list) else None
        c, b = lu.req("DELETE", f"/api/v1/device-tokens/{tid}")
        check("[app] a token can be revoked", c in (200, 204), f"{c} {b}")
        c, b = Luna(18080).get("/api/v1/drives", headers={"Authorization": f"Bearer {tok}"})
        check("[app] a revoked token stops working at once", c == 401, f"{c} {b}")
    # Connect (mock) and network
    c, b = lu.get("/api/v1/connect/status")
    show("connect status", (c, b))
    check("[app] Connect status answers", c == 200, f"{c} {b}")
    c, b = lu.get("/api/v1/network/status")
    show("network status", (c, b))
    check("[app] network status answers", c == 200, f"{c} {b}")
    c, b = lu.get("/api/v1/system/health/check")
    check("[app] the full health check answers", c == 200 and isinstance(b, dict), f"{c} {str(b)[:200]}")
    show("health check", (c, str(b)[:600]))
    # assets
    for path, what in (("/drawio/index.html", "diagram editor"), ("/eurooffice/web-apps/apps/api/documents/api.js", "office editor")):
        c, b = lu.get(path, raw=True)
        check(f"[app] the {what} files are served from this Luna", c == 200 and len(b) > 200, f"{c} {len(b) if b else 0}")
    # accounts
    c, b = lu.req("PATCH", "/api/v1/auth/me", {"current_password": ADMIN["password"], "new_password": "a-new-long-password-5"})
    show("change password", (c, b))
    check("[app] the admin can change their password", c == 200, f"{c} {b}")
    c, b = Luna(18080).post("/api/v1/auth/login", {"username": "admin", "password": ADMIN["password"]})
    check("[app] the old password stops working", c in (400, 401), f"{c} {b}")
    c, b = Luna(18080).post("/api/v1/auth/login", {"username": "admin", "password": "a-new-long-password-5"})
    check("[app] the new password works", c == 200, f"{c} {b}")
    vm.sh("sync")
    vm.quit()


def stage_eject_busy():
    """A drive full of files and photos, ejected right after it was added, while Luna is still indexing it."""
    say("-- eject while Luna is still indexing")
    from PIL import Image
    tree = f"{WORK}/fx/busy-tree"
    shutil.rmtree(tree, ignore_errors=True)
    os.makedirs(tree)
    jpg = f"{WORK}/fx/busy.jpg"
    Image.new("RGB", (800, 600), (30, 120, 200)).save(jpg, quality=70)
    for d in range(200):
        os.makedirs(f"{tree}/Folder {d:03d}/Sub")
        for i in range(60):
            open(f"{tree}/Folder {d:03d}/note-{i}.txt", "w").write(f"file {d}/{i}\n" * 20)
        for i in range(40):
            shutil.copy(jpg, f"{tree}/Folder {d:03d}/Sub/photo-{i}.jpg")
    img = f"{WORK}/fx/busy.img"
    sh(f"rm -f {img}; truncate -s 1500M {img}; mke2fs -q -t ext4 -m 0 -L BUSY -d {tree} {img}")
    shutil.rmtree(tree, ignore_errors=True)
    vm, lu = bring_up("busy", usb=img)
    check("web UI answers", lu.wait_up(240))
    lu.post("/api/v1/auth/register", ADMIN)
    check("admin signs in", login_admin(lu))
    lu.post("/api/v1/setup", {"setup_completed": True, "current_step": "done"})
    d = detected(lu, lambda x: True, 60)
    c, b = lu.post(f"/api/v1/drives/{d[0]['name']}/adopt", {"label": "Lots of files", "erase": False})
    D = b.get("id")
    check("the drive with 20,000 files is added", c == 200 and D, f"{c} {b}")
    t0 = time.time()
    c, b = lu.post(f"/api/v1/drives/{D}/eject")
    took = time.time() - t0
    say(f"    eject answered after {took:.1f}s with {c}")
    c2 = c
    while c != 200 and time.time() - t0 < 90:
        time.sleep(3)
        c, b = lu.post(f"/api/v1/drives/{D}/eject")
    check("eject right after adding works, without the person having to try again", c2 == 200, f"first answer {c2}; {b}")
    check("and it did work in the end", c == 200, f"{c} {b}")
    rc, o = vm.sh("cat /proc/mounts | grep -c mounts/drives")
    check("nothing of the drive is still mounted", o.strip().endswith("0"), o)
    vm.sh("sync")
    vm.quit()


def stage_reset():
    """Factory reset: accounts, shares and settings go; the files on the drives stay."""
    say("-- factory reset")
    fx = make_fixtures()
    img = copy_fixture(fx, "fat32", "reset")
    before = image_root_listing("fat32", img)
    vm, lu = bring_up("reset", usb=img)
    check("web UI answers", lu.wait_up(240))
    lu.post("/api/v1/auth/register", ADMIN)
    check("admin signs in", login_admin(lu))
    lu.post("/api/v1/setup", {"setup_completed": True, "current_step": "done", "name": "Reset me"})
    d = detected(lu, lambda x: True, 60)
    c, b = lu.post(f"/api/v1/drives/{d[0]['name']}/adopt", {"label": "Keep my files", "erase": False})
    D = b.get("id")
    check("a drive is added", c == 200 and D, f"{c} {b}")
    data = os.urandom(500_000)
    c, b, _ = upload(lu, D, "precious.bin", data)
    check("a file is stored", c == 200, f"{c} {b}")
    lu.post("/api/v1/users", {"username": "sam", "display_name": "Sam", "password": "sams-long-password-7", "role": "member"})
    c, b = lu.post("/api/v1/system/factory-reset", {"confirm": False, "password": ADMIN["password"]})
    check("reset needs the confirm box ticked", c == 400, f"{c} {b}")
    c, b = lu.post("/api/v1/system/factory-reset", {"confirm": True, "password": "not-my-password-1"})
    check("reset needs the right password", c == 401, f"{c} {b}")
    sam = Luna(18080)
    sam.post("/api/v1/auth/login", {"username": "sam", "password": "sams-long-password-7"})
    c, b = sam.post("/api/v1/system/factory-reset", {"confirm": True, "password": "sams-long-password-7"})
    check("a member cannot reset Luna", c == 403, f"{c} {b}")
    c, b = lu.post("/api/v1/system/factory-reset", {"confirm": True, "password": ADMIN["password"]})
    check("an admin with the right password can reset", c == 200, f"{c} {b}")
    time.sleep(5)
    check("Luna is still answering", lu.wait_up(60))
    c, b = Luna(18080).get("/api/v1/auth/status")
    check("it is back to first-run: no admin", c == 200 and b.get("has_admin") is False, f"{c} {b}")
    c, b = Luna(18080).get("/api/v1/setup")
    check("and the setup wizard is open again", c == 200 and b.get("setup_completed") is False, f"{c} {b}")
    lu2 = Luna(18080)
    c, b = lu2.post("/api/v1/auth/register", {"username": "newadmin", "display_name": "New", "password": "brand-new-long-pass-3"})
    check("a new admin can be created", c == 200 and b.get("role") == "admin", f"{c} {b}")
    lu2.post("/api/v1/auth/login", {"username": "newadmin", "password": "brand-new-long-pass-3"})
    c, bd = lu2.get("/api/v1/drives")
    check("no drives are registered any more", c == 200 and bd == [], f"{c} {bd}")
    vm.sh("sync")
    d2 = detected(lu2, lambda x: True, 60)
    check("the stick is offered as a new drive again", bool(d2))
    if d2:
        c, b = lu2.post(f"/api/v1/drives/{d2[0]['name']}/adopt", {"label": "Again", "erase": False})
        D2 = b.get("id")
        check("and can be added again", c == 200 and D2, f"{c} {b}")
        c, got = download(lu2, D2, "precious.bin")
        check("the file stored before the reset is still there, unchanged", c == 200 and got == data, f"{c}")
    c, b = lu2.post("/api/v1/system/factory-reset", {"confirm": True, "password": "brand-new-long-pass-3"})
    time.sleep(3)
    vm.sh("sync")
    vm.quit()
    vm.wait_exit(30)
    after = image_root_listing("fat32", img)
    left = [a for a in after if a.startswith(".luna")]
    check("after reset the drive carries none of this Luna's hidden files", not left, str(left))
    check("and everything that was on it is still there", all(x in after for x in before) and "precious.bin" in after, str(after))


def recovery_stick(name, files):
    img = f"{WORK}/fx/{name}.img"
    os.makedirs(f"{WORK}/fx", exist_ok=True)
    sh(f"rm -f {img}; truncate -s 64M {img}; mkfs.vfat -F 32 -n RECOVER {img} >/dev/null")
    for fname, content in files.items():
        tmp = f"{WORK}/fx/{name}.tmp"
        open(tmp, "w").write(content)
        sh(f"MTOOLS_SKIP_CHECK=1 mcopy -o -i {img} {tmp} ::'{fname}'")
    return img


def stage_recovery():
    """Forgotten password: a dedicated stick named for the device token, honoured only at boot."""
    say("-- password recovery stick")
    vm, lu = bring_up("recovery")
    check("web UI answers", lu.wait_up(240))
    lu.post("/api/v1/auth/register", ADMIN)
    check("admin signs in", login_admin(lu))
    lu.post("/api/v1/setup", {"setup_completed": True, "current_step": "done"})
    lu.post("/api/v1/users", {"username": "sam", "display_name": "Sam", "password": "sams-long-password-7", "role": "member"})
    new_pw = "recovered-pass-12345"
    payload = json.dumps({"user": "g-admin", "password": new_pw})

    def reboot_with(img):
        vm.usb_add("u-rec", img)
        vm.sh("sync")
        vm.serial_send("reboot\n")
        ok = wait_reboot_up(vm, lu, 240)
        vm.usb_del("u-rec")
        return ok

    # wrong token in the name: ignored
    img = recovery_stick("rec-wrong", {"luna-recover-ZZZZZZZZZZZZZZZZ.luna": payload})
    check("[wrong token] Luna restarts", reboot_with(img))
    c, b = Luna(18080).post("/api/v1/auth/login", {"username": "admin", "password": new_pw})
    check("[wrong token] a stick with the wrong token does nothing", c in (400, 401), f"{c} {b}")
    # extra files on the stick: not a dedicated recovery stick
    img = recovery_stick("rec-extra", {f"luna-recover-{TOKEN}.luna": payload, "holiday.jpg": "x"})
    check("[extra files] Luna restarts", reboot_with(img))
    c, b = Luna(18080).post("/api/v1/auth/login", {"username": "admin", "password": new_pw})
    check("[extra files] a stick that also holds other files is refused", c in (400, 401), f"{c} {b}")
    # the real thing
    img = recovery_stick("rec-ok", {f"luna-recover-{TOKEN}.luna": payload})
    check("[recovery] Luna restarts with the stick in", reboot_with(img))
    c, b = Luna(18080).post("/api/v1/auth/login", {"username": "admin", "password": new_pw})
    if c != 200:
        rc, o = vm.sh("grep -i -E 'recover|stick' /var/lib/luna/logs/luna.log | tail -n 12 | cut -c1-300; cat /var/lib/luna/device-token; echo; grep -c . /var/lib/luna/logs/luna.log")
        say("    log:\n" + o)
    check("[recovery] the admin can sign in with the new password", c == 200 and b.get("role") == "admin", f"{c} {b}")
    c, b = Luna(18080).post("/api/v1/auth/login", {"username": "admin", "password": ADMIN["password"]})
    check("[recovery] the old password no longer works", c in (400, 401), f"{c} {b}")
    c, b = Luna(18080).post("/api/v1/auth/login", {"username": "sam", "password": "sams-long-password-7"})
    check("[recovery] other people's passwords were not touched", c == 200, f"{c} {b}")
    left = image_root_listing("fat32", img)
    say(f"    stick afterwards: {left}")
    # not honoured when plugged in while running
    img2 = recovery_stick("rec-live", {f"luna-recover-{TOKEN}.luna": json.dumps({"user": "g-admin", "password": "another-recovered-1"})})
    vm.usb_add("u-rec2", img2)
    time.sleep(15)
    c, b = Luna(18080).post("/api/v1/auth/login", {"username": "admin", "password": "another-recovered-1"})
    check("[live] a recovery stick plugged in while Luna runs is ignored", c in (400, 401), f"{c} {b}")
    vm.sh("sync")
    vm.quit()


def set_grubenv(disk, **kv):
    """Write ESP/grub/grubenv offline (a fixed 1024-byte block, as grub-editenv would)."""
    body = "# GRUB Environment Block\n" + "".join(f"{k}={v}\n" for k, v in kv.items())
    body += "#" * (1024 - len(body))
    esp_put(disk, "/grub/grubenv", body)


def stage_grub_fallback():
    """GRUB must not stop at an error when the chosen system cannot be started."""
    say("-- GRUB fallback")
    start_mock_connect()
    cases = {
        "filesystem not found": lambda d: sh(f"tune2fs -U random '{d}?offset={parts(d)[4][0]}' >/dev/null 2>&1"),
        "kernel missing": lambda d: sh(f"debugfs -w -R 'rm /boot/vmlinuz-lts' '{d}?offset={parts(d)[4][0]}' >/dev/null 2>&1"),
    }
    for name, breakit in cases.items():
        T = f"[{name}] "
        disk = f"{WORK}/gf.raw"
        sh(f"rm -f {disk}; cp --sparse=always --reflink=auto {WORK}/golden-sata.raw {disk}")
        serial_console_for_tests(disk)
        point_at_mock_connect(disk)
        breakit(disk)
        set_grubenv(disk, luna_slot="B", luna_boot_ok="1", luna_tries="3")
        vm = VM("gf", [{"file": disk, "bus": "sata", "bootindex": 0}], http_port=18080)
        vm.start()
        lu = Luna(18080)
        up = lu.wait_up(180)
        check(T + "slot B cannot start, yet Luna comes up by itself", up)
        if not up:
            say("    screen: " + vm.ocr("gf-screen").strip()[-400:])
            vm.quit()
            continue
        time.sleep(10)
        check(T + "it is running from slot A", slot_of(vm) == "A", str(slot_of(vm)))
        vm.sh("sync; sync")
        vm.quit()
        vm.wait_exit(30)
        env = esp_grubenv(disk)
        check(T + "the next start will go straight to slot A", env.get("luna_slot") == "A" and env.get("luna_boot_ok") == "1", str(env))
        os.unlink(disk)


def stage_flow():
    vm = golden_vm("flow", "sata", xhci=True)
    lu = Luna(18080)
    check("web UI answers", lu.wait_up(240))
    part_setup(vm, lu)
    fx = make_fixtures()
    adopted = part_drives(vm, lu, fx)
    for kind, did in adopted.items():
        part_files(vm, lu, did, kind)
        if kind == "ext4":
            part_people(vm, lu, did)
            part_gallery(vm, lu, did)
    part_drive_lifecycle(vm, lu, fx)
    part_foreign_drives(vm, lu, fx)
    part_ratelimit()
    vm.quit()


# -- signed updates ---------------------------------------------------------------
UPD = f"{WORK}/upd"
FEED_URL = "http://10.0.2.2:18900"
_feed_srv = None
_pub_clock = int(time.time())


def feed_server():
    global _feed_srv
    if _feed_srv and _feed_srv.poll() is None:
        return
    import subprocess
    os.makedirs(f"{UPD}/luna", exist_ok=True)
    os.makedirs(f"{UPD}/files", exist_ok=True)
    _feed_srv = subprocess.Popen(["python3", "-m", "http.server", "18900", "--bind", "0.0.0.0", "-d", UPD],
                                 stdout=open(f"{WORK}/feed-server.log", "w"), stderr=subprocess.STDOUT)
    time.sleep(1)


def minisign_keys(name):
    """(public key line, secret key path). Passwordless test keys."""
    sec, pub = f"{UPD}/{name}.key", f"{UPD}/{name}.pub"
    if not os.path.exists(sec):
        os.makedirs(UPD, exist_ok=True)
        sh(f"minisign -G -W -f -p {pub} -s {sec} >/dev/null")
    return open(pub).read().strip().split("\n")[-1], sec


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def os_image_variant(name, edits):
    """A copy of the shipped OS image with a few files changed (offline, debugfs).

    Always carries the serial test shell so the checks can look inside, and a
    marker file naming the variant.
    """
    out = f"{UPD}/files/{name}.img.xz"
    if os.path.exists(out):
        return out
    raw = f"{WORK}/{name}.raw"
    sh(f"xz -dc {SLOT_IMG} > {raw}")
    inittab = sh(f"debugfs -R 'cat /etc/inittab' {raw} 2>/dev/null")
    edits = dict(edits)
    edits["/etc/inittab"] = inittab.rstrip("\n") + "\nttyS0::respawn:/usr/bin/env TERM=dumb /bin/ash\n"
    edits["/etc/luna-os-release"] = f"os_release=e2e-{name}\n"
    cmds = []
    for i, (path, content) in enumerate(edits.items()):
        d, f = os.path.split(path)
        tmp = f"{WORK}/variant-{i}.tmp"
        mode = "0100755" if isinstance(content, tuple) else "0100644"
        data = content[0] if isinstance(content, tuple) else content
        open(tmp, "wb").write(data if isinstance(data, bytes) else data.encode())
        cmds += [f"cd {d}", f"rm {f}", f"write {tmp} {f}", f"sif {f} mode {mode}"]
    open(f"{WORK}/variant.cmds", "w").write("\n".join(cmds) + "\n")
    sh(f"debugfs -w -f {WORK}/variant.cmds {raw} >/dev/null 2>&1")
    r = sh(f"e2fsck -fn {raw}; echo rc=$?", check_rc=False)
    assert "rc=0" in r, r[-300:]
    # Every real build has its own random filesystem UUID. Variants made from one image
    # must too, or the spare slot briefly shares the running slot's UUID during a write.
    sh(f"e2fsck -fy {raw} >/dev/null 2>&1; tune2fs -U random {raw} >/dev/null")
    sh(f"xz -T0 -3 -c {raw} > {out}")
    os.unlink(raw)
    return out


def publish(version, lunad=True, os_img=None, key="good", published=None, tamper=False, notes="E2E update", lunad_bytes=None):
    """Write a signed feed (unit luna, channel stable) and the files it lists."""
    feed_server()
    pub, sec = minisign_keys(key)
    parts = []
    if lunad:
        src = LUNAD_BIN
        dst = f"{UPD}/files/lunad-{version}"
        if lunad_bytes is not None:
            open(dst, "wb").write(lunad_bytes)
        else:
            shutil.copy(src, dst)
        digest = sha256_file(dst)
        if tamper:
            open(dst, "ab").write(b"tampered")
        parts.append({"name": "lunad", "os": "linux", "arch": "amd64", "file": "lunad-linux-amd64-musl",
                      "size": os.path.getsize(dst), "sha256": digest, "urls": [f"{FEED_URL}/files/lunad-{version}"]})
    if os_img:
        parts.append({"name": "os", "os": "linux", "arch": "amd64", "file": "luna-os-x86_64.img.xz",
                      "size": os.path.getsize(os_img), "sha256": sha256_file(os_img),
                      "urls": [f"{FEED_URL}/files/{os.path.basename(os_img)}"]})
    global _pub_clock
    if published is None:
        _pub_clock = max(_pub_clock + 60, int(time.time()))
        published = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_pub_clock))
    feed = {"format": 1, "unit": "luna", "channel": "stable", "version": version, "published": published,
            "notes": notes, "parts": parts, "api": {"version": 1, "oldest_supported": 1}}
    path = f"{UPD}/luna/stable.json"
    open(path, "w").write(json.dumps(feed, indent=1))
    if os.path.exists(path + ".minisig"):
        os.unlink(path + ".minisig")
    sh(f"minisign -S -s {sec} -m {path} -x {path}.minisig -t 'e2e {version}'")
    return feed


LUNAD_BIN = "/lunad"  # the musl lunad this OS image was built with


def slot_of(vm):
    rc, out = vm.sh("cat /proc/cmdline")
    m = re.search(r"luna\.slot=([AB])", out)
    return m.group(1) if m else None


def apply_update(lu, tries=1):
    return lu.post("/api/v1/system/updates/apply", timeout=300)


def api_check(lu, force=True):
    return lu.get("/api/v1/system/updates?force=true" if force else "/api/v1/system/updates", timeout=60)


def wait_reboot_up(vm, lu, timeout=300):
    """After the guest reboots on its own: wait for the API to come back."""
    # the API goes away first; then returns
    end = time.time() + timeout
    saw_down = False
    while time.time() < end:
        c, _ = lu.get("/api/v1/health", timeout=3)
        if c != 200:
            saw_down = True
        elif saw_down:
            return True
        time.sleep(2)
    return False


def stage_update():
    """Signed updates end to end: lunad-only, OS to the other slot, rollbacks, bad input."""
    say("-- updates")
    feed_server()
    good_pub, _ = minisign_keys("good")
    evil_pub, _ = minisign_keys("evil")
    g = f"{WORK}/golden-sata.raw"
    serial_console_for_tests(g)
    start_mock_connect()
    vm = boot_disk("update", g, "sata", port=18080)
    lu = Luna(18080)
    check("web UI answers", lu.wait_up(240))
    lu.post("/api/v1/auth/register", ADMIN)
    c, b = lu.post("/api/v1/auth/login", {"username": ADMIN["username"], "password": ADMIN["password"]})
    lu.post("/api/v1/setup", {"setup_completed": True, "current_step": "done"})
    # Connect is off for the OS update path: the new slot has no test hook for the mock.
    vm.sh("rm -f /var/lib/luna/device-token")
    c, b = lu.get("/api/v1/system/updates/source")
    check("update source: shows the built-in signer", c == 200 and b.get("default_keys") is True and b.get("effective_keys"), f"{c} {b}")
    c, b = lu.req("PUT", "/api/v1/system/updates/source", {"feed_url": FEED_URL, "channel": "stable", "keys": [good_pub]})
    check("update source: a local feed and test key can be saved", c == 200 and b.get("ok"), f"{c} {b}")
    c, b = lu.req("PUT", "/api/v1/system/updates/source", {"feed_url": "https://example.com/feed", "channel": "nightly", "keys": [good_pub]})
    check("update source: an unknown channel is refused plainly", c == 400 and "Stable or Beta" in str(b), f"{c} {b}")
    c, b = lu.req("PUT", "/api/v1/system/updates/source", {"feed_url": FEED_URL, "channel": "stable", "keys": ["not a key"]})
    check("update source: a malformed key is refused plainly", c == 400 and "minisign" in str(b), f"{c} {b}")
    c, b = lu.req("PUT", "/api/v1/system/updates/source", {"feed_url": "ftp://x", "channel": "stable", "keys": [good_pub]})
    check("update source: a non-web address is refused plainly", c == 400, f"{c} {b}")
    c, b = lu.req("PUT", "/api/v1/system/updates/source", {"feed_url": FEED_URL, "channel": "stable", "keys": [good_pub]})
    old_hash = open(f"{DIST}/luna-os-x86_64.img.xz.sha256").read().split()[0]
    rc, h = vm.sh("cat /var/lib/luna/os-image.sha256")
    check("OS image hash is recorded before any update", old_hash in h, h)

    # nothing published
    for f in ("stable.json", "stable.json.minisig"):
        if os.path.exists(f"{UPD}/luna/{f}"):
            os.unlink(f"{UPD}/luna/{f}")
    c, b = api_check(lu)
    check("no feed yet: a plain 'nothing published' answer", c in (404, 502, 503) and isinstance(b, dict) and b.get("error"), f"{c} {b}")
    # signed by the wrong key
    publish("0.0.2", key="evil")
    c, b = api_check(lu)
    check("a feed signed by a key Luna does not trust is refused", c >= 400 and isinstance(b, dict) and b.get("error"), f"{c} {b}")
    c, b = apply_update(lu)
    check("and nothing is installed from it", c >= 400, f"{c} {b}")
    rc, o = vm.sh("ls /var/lib/luna/bin 2>&1; cat /var/lib/luna/os-image.sha256")
    check("untrusted feed left no new lunad and kept the OS hash", "lunad" not in o.split("\n")[0] and old_hash in o, o)
    # a part whose bytes do not match the signed checksum
    publish("0.0.2", key="good", tamper=True)
    c, b = api_check(lu)
    check("a signed feed is accepted", c == 200 and b.get("update_available") is True and b.get("latest_version") == "0.0.2", f"{c} {b}")
    c, b = apply_update(lu)
    check("a download that does not match its checksum is refused", c >= 400 and isinstance(b, dict) and b.get("error"), f"{c} {b}")
    rc, o = vm.sh("ls /var/lib/luna/bin 2>&1")
    check("nothing from the bad download is left installed", "lunad" not in o or "No such file" in o, o)
    # the feed cannot go backwards (replay of an older list)
    publish("0.0.4", key="good")
    api_check(lu)
    publish("0.0.3", key="good", published="2026-10-01T00:00:00Z")
    c, b = api_check(lu)
    check("an older feed replayed after a newer one is refused", c >= 400 or b.get("update_available") is False, f"{c} {b}")

    # lunad-only update
    publish("0.0.5", key="good")
    c, b = api_check(lu)
    check("lunad-only update is offered", c == 200 and b.get("update_available") and b.get("reboot_required") is False, f"{c} {b}")
    rc, pid_before = vm.sh("pidof lunad")
    c, b = apply_update(lu)
    check("lunad-only update installs", c == 200 and b.get("ok") and b.get("reboot_required") is False, f"{c} {b}")
    time.sleep(8)
    check("Luna comes back by itself after a lunad-only update", lu.wait_up(90))
    rc, pid_after = vm.sh("pidof lunad")
    check("lunad restarted (new process)", pid_before and pid_after and pid_before.split()[-1] != pid_after.split()[-1], f"{pid_before} -> {pid_after}")
    rc, o = vm.sh("ls -la /var/lib/luna/bin/lunad")
    check("the new lunad is stored on the data partition", "lunad" in o and "No such" not in o, o)
    c, b = lu.get("/api/v1/auth/me")
    check("you stay signed in across a lunad restart", c == 200 and b and b.get("role") == "admin", f"{c} {b}")

    # OS update to slot B
    good_v2 = os_image_variant("v2", {})
    publish("0.0.6", key="good", os_img=good_v2)
    c, b = api_check(lu)
    check("an OS update is offered and says it needs a restart", c == 200 and b.get("update_available") and b.get("reboot_required") is True, f"{c} {b}")
    check("the active slot is A before the update", slot_of(vm) == "A")
    c, b = apply_update(lu)
    check("the OS update is accepted", c == 200 and b.get("ok") and b.get("reboot_required"), f"{c} {b}")
    check("Luna restarts into the new system", wait_reboot_up(vm, lu, 300))
    time.sleep(10)
    check("it is now running slot B", slot_of(vm) == "B")
    rc, o = vm.sh("cat /etc/luna-os-release")
    check("slot B holds the new OS image", "e2e-v2" in o, o)
    c, b = lu.post("/api/v1/auth/login", {"username": ADMIN["username"], "password": ADMIN["password"]})
    check("accounts and data survived the OS update", c == 200, f"{c} {b}")
    time.sleep(20)
    rc, o = vm.sh("cat /var/lib/luna/os-image.sha256")
    new_hash = sha256_file(good_v2)
    check("the new OS image is recorded only after the new system proved itself", new_hash in o, o)
    c, b = api_check(lu)
    # (the test feed's lunad part always reads as newer than the baked 0.0.1, so only the OS part is judged)
    check("no further OS update is offered", c == 200 and b.get("reboot_required") is False and b.get("os_update_failed") is None, f"{c} {b}")

    # -- and back to slot A with a second update
    good_v3 = os_image_variant("v3", {})
    publish("0.0.7", key="good", os_img=good_v3)
    c, b = api_check(lu)
    check("a second OS update is offered", c == 200 and b.get("update_available") and b.get("reboot_required"), f"{c} {b}")
    c, b = apply_update(lu)
    check("the second OS update is accepted", c == 200 and b.get("ok"), f"{c} {b}")
    check("Luna restarts into the other slot", wait_reboot_up(vm, lu, 300))
    time.sleep(10)
    check("it runs from slot A again", slot_of(vm) == "A")
    rc, o = vm.sh("cat /etc/luna-os-release")
    check("slot A holds the newest image", "e2e-v3" in o, o)
    time.sleep(20)
    rc, o = vm.sh("cat /var/lib/luna/os-image.sha256")
    check("the newest image is recorded", sha256_file(good_v3) in o, o)
    login_admin(lu)

    def rollback_case(tag, variant_edits, version, note, expect_slot, expect_panic=False, wait=900, lunad_bytes=None):
        T = f"[{tag}] "
        img = os_image_variant(tag, variant_edits)
        # An OS release also ships lunad, and luna-run falls back to that copy when the
        # baked one cannot run: to test "lunad cannot start" both must be broken.
        publish(version, key="good", os_img=img, lunad_bytes=lunad_bytes)
        c, b = api_check(lu)
        check(T + "the update is offered", c == 200 and b.get("update_available"), f"{c} {b}")
        before_hash = vm.sh("cat /var/lib/luna/os-image.sha256")[1]
        c, b = apply_update(lu)
        check(T + "the update is accepted", c == 200 and b.get("ok"), f"{c} {b}")
        t0 = time.time()
        # the new system fails to come up; Luna must end up back on the old one by itself
        end = time.time() + wait
        back = False
        saw_new = False
        while time.time() < end:
            c, _ = lu.get("/api/v1/health", timeout=3)
            txt = vm.serial_text()
            if "e2e-" + tag in txt or f"luna.slot={'B' if expect_slot == 'A' else 'A'}" in txt:
                saw_new = True
            if c == 200 and time.time() - t0 > 40:
                back = True
                break
            time.sleep(5)
        say(f"    back on a working system after {time.time() - t0:.0f}s")
        check(T + "Luna comes back by itself on a working system", back)
        time.sleep(15)
        check(T + f"it is back on slot {expect_slot}", slot_of(vm) == expect_slot, str(slot_of(vm)))
        if expect_panic:
            check(T + "the broken system was seen to panic and restart", "panic" in vm.serial_text().lower() or "Kernel panic" in vm.serial_text())
        rc, o = vm.sh("cat /var/lib/luna/os-image.sha256")
        check(T + "the image hash still names the working system", o.strip() == before_hash.strip(), f"{o} vs {before_hash}")
        login_admin(lu)
        time.sleep(15)
        c, b = api_check(lu)
        failed = b.get("os_update_failed") if isinstance(b, dict) else None
        check(T + "Luna reports that the update did not start, with its version", c == 200 and failed and failed.get("version") == version, f"{c} {failed}")
        check(T + "and it does not keep re-installing the broken image", b.get("reboot_required") is False, f"{b}")
        c, b = lu.post("/api/v1/system/updates/os-failed/clear")
        check(T + "an admin can clear the failure", c == 200, f"{c} {b}")
        c, b = api_check(lu)
        check(T + "after clearing, the same image is offered again", c == 200 and b.get("reboot_required") is True and b.get("os_update_failed") is None, f"{c} {b}")

    # luna-run falls back to the data-dir lunad when the baked one cannot run, so the
    # earlier lunad-only update would (rightly) rescue this image: remove it first.
    vm.sh("rm -f /var/lib/luna/bin/lunad")
    cur = slot_of(vm)
    rollback_case("badlunad", {"/usr/local/bin/lunad": (b"#!/bin/sh\nexit 1\n",)}, "0.0.8", "lunad cannot start", cur,
                  lunad_bytes=b"#!/bin/sh\nexit 1\n")
    cur = slot_of(vm)
    rollback_case("badboot", {"/boot/initramfs-lts": b"this is not an initramfs\n" * 100}, "0.0.9", "kernel cannot find its root", cur, expect_panic=True)

    # (a power cut during the write has its own stage, update-powercut, on a raw disk)
    rc, o = vm.sh("cat /var/lib/luna/os-image.sha256")
    vm.sh("sync; sync")
    vm.quit()
    vm.wait_exit(60)
    raw = overlay_to_raw("update")
    rc_, out = fsck_data(raw)
    check("the data partition is clean at the end", rc_ in (0, 1), out[-200:])
    for n, name in ((3, "A"), (4, "B")):
        r = ext_fsck(raw, n)
        check(f"slot {name} is a clean filesystem at the end", "rc=0" in r, r[-200:])
    return


def stage_update_powercut():
    """The power fails while an OS update is being written, at several moments."""
    say("-- power cut during an OS update")
    feed_server()
    good_pub, _ = minisign_keys("good")
    good_v4 = os_image_variant("v4", {})
    start_mock_connect()
    for cut in (2, 8, 16):
        T = f"[cut at {cut}s] "
        disk = f"{WORK}/pc-{cut}.raw"
        sh(f"rm -f {disk}; cp --sparse=always --reflink=auto {WORK}/golden-sata.raw {disk}")
        serial_console_for_tests(disk)
        vm = VM(f"pc{cut}", [{"file": disk, "bus": "sata", "bootindex": 0}], http_port=18080)
        vm.start()
        lu = Luna(18080)
        check(T + "Luna starts", lu.wait_up(240))
        lu.post("/api/v1/auth/register", ADMIN)
        login_admin(lu)
        lu.post("/api/v1/setup", {"setup_completed": True, "current_step": "done"})
        vm.sh("rm -f /var/lib/luna/device-token")
        lu.req("PUT", "/api/v1/system/updates/source", {"feed_url": FEED_URL, "channel": "stable", "keys": [good_pub]})
        publish(f"0.2.{cut}", key="good", os_img=good_v4)
        c, b = api_check(lu)
        check(T + "the update is offered", c == 200 and b.get("update_available"), f"{c} {b}")
        import threading
        th = threading.Thread(target=lambda: apply_update(lu))
        th.start()
        time.sleep(cut)
        vm.kill()
        th.join(30)
        vm = VM(f"pc{cut}b", [{"file": disk, "bus": "sata", "bootindex": 0}], http_port=18080)
        vm.start()
        lu = Luna(18080)
        up = lu.wait_up(240)
        check(T + "Luna still boots after the power cut", up)
        if not up:
            say(vm.serial_text()[-1200:])
            vm.quit()
            continue
        time.sleep(10)
        slot = slot_of(vm)
        check(T + "accounts are intact", login_admin(lu))
        if slot == "A":
            # cut before the new system was armed: nothing changed, the update can be done again
            c, b = api_check(lu)
            check(T + "the update is offered again", c == 200 and b.get("reboot_required") is True, f"{c} {b}")
            c, b = apply_update(lu)
            check(T + "and installs on the next try", c == 200 and b.get("ok"), f"{c} {b}")
            check(T + "Luna restarts into the new system", wait_reboot_up(vm, lu, 300))
            time.sleep(10)
        else:
            # the write had finished and the new system was armed before the cut: it must be whole
            say(f"    (the update had already been armed when the power went; Luna came up on slot {slot})")
        check(T + "it runs from slot B", slot_of(vm) == "B", str(slot_of(vm)))
        rc, o = vm.sh("cat /etc/luna-os-release")
        check(T + "with the new image", "e2e-v4" in o, o)
        vm.sh("sync; sync")
        vm.quit()
        vm.wait_exit(30)
        for n, name in ((3, "A"), (4, "B")):
            r = ext_fsck(disk, n)
            check(T + f"slot {name} is a clean filesystem afterwards", "rc=0" in r, r[-200:])
        os.unlink(disk)




def stage_lab():
    """Boot, set up, add a FAT32 stick, then wait so you can poke at it (podman exec luna-e2e ...).

    The web UI is at http://10.0.2.2:... inside the container: curl http://127.0.0.1:18080
    Run a command in the guest: write it to /work/lab.cmd, read /work/lab.result.
    Stop it with: podman exec luna-e2e touch /work/lab.stop
    """
    vm = golden_vm("lab", "sata", xhci=True)
    lu = Luna(18080)
    lu.wait_up(240)
    lu.post("/api/v1/auth/register", ADMIN)
    lu.post("/api/v1/auth/login", {"username": ADMIN["username"], "password": ADMIN["password"]})
    lu.post("/api/v1/setup", {"setup_completed": True})
    fx = make_fixtures()
    d = plug(vm, lu, "u-lab", fx["fat32"])
    c, b = lu.post(f"/api/v1/drives/{d['name']}/adopt", {"label": "Lab", "erase": False})
    say(f"LAB READY drive={b.get('id')}")
    open(f"{WORK}/lab.drive", "w").write(b.get("id", ""))
    if os.path.exists(f"{WORK}/lab.stop"):
        os.unlink(f"{WORK}/lab.stop")
    while not os.path.exists(f"{WORK}/lab.stop"):
        if os.path.exists(f"{WORK}/lab.cmd"):
            cmd = open(f"{WORK}/lab.cmd").read()
            os.unlink(f"{WORK}/lab.cmd")
            if cmd.startswith("HMP "):
                rc, out = 0, vm.hmp(cmd[4:])
            else:
                rc, out = vm.sh(cmd, timeout=120)
            open(f"{WORK}/lab.result", "w").write(f"rc={rc}\n{out}\n")
        time.sleep(1)
    vm.quit()

STAGES = {}


def stage(fn):
    STAGES[fn.__name__.replace("stage_", "").replace("_", "-")] = fn
    return fn


STAGES["explore"] = stage_explore
STAGES["boot"] = stage_boot
STAGES["lab"] = stage_lab
STAGES["update"] = stage_update
STAGES["eject-busy"] = stage_eject_busy
STAGES["grub-fallback"] = stage_grub_fallback
STAGES["update-powercut"] = stage_update_powercut
STAGES["recovery"] = stage_recovery
STAGES["reset"] = stage_reset
STAGES["app"] = stage_app
STAGES["bigfiles"] = stage_bigfiles
STAGES["matrix"] = stage_matrix
STAGES["installer-prod-bios"] = stage_installer_prod_bios
STAGES["installer-prod-uefi"] = stage_installer_prod_uefi
STAGES["installer-prompts"] = stage_installer_prompts
STAGES["resilience"] = stage_resilience
STAGES["flow"] = stage_flow
STAGES["installer-safety"] = stage_installer_safety
for _bus in ("sata", "nvme", "mmc", "virtio"):
    STAGES[f"install-{_bus}"] = (lambda b: lambda: stage_install(b, "bios"))(_bus)


def main():
    args = sys.argv[1:]
    if "--list" in args:
        print("\n".join(STAGES))
        return 0
    for n in args:
        if n not in STAGES:
            print(f"unknown stage {n!r}; try --list")
            return 2
    # lab/explore are for poking around; the install-<bus> stages run inside matrix.
    default = ["install-sata", "installer-safety", "installer-prompts", "installer-prod-bios", "installer-prod-uefi",
               "boot", "flow", "app", "eject-busy", "reset", "recovery", "resilience", "grub-fallback", "update", "update-powercut",
               "matrix", "bigfiles"]
    names = args or default
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
