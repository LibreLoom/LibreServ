//! DHCP on Ethernet link-up (cable insert), not boot-only.

use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const RETRY_WHILE_UP: Duration = Duration::from_secs(10);
/// How often the link watcher looks while some cable has a link but no
/// address yet, or when the kernel can't tell it about changes.
const LOOK_EVERY: Duration = Duration::from_secs(2);

/// Network interface mutations (`ip link set ... up`) and DHCP client daemons
/// require root privileges (`CAP_NET_ADMIN`). In local development or
/// unprivileged containers, skip mutating host network interfaces.
pub(crate) fn can_manage_interfaces() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: geteuid is always safe to call on Unix.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Run DHCP on every non-wireless interface that has carrier.
pub fn request_on_wired(sys_net: &Path) {
    let Ok(entries) = std::fs::read_dir(sys_net) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_wired_iface(&name, &dir) {
            continue;
        }
        bring_iface_up(&name);
        let carrier = read_carrier(&dir);
        if !carrier {
            continue;
        }
        if !iface_has_usable_ipv4(&name) {
            dhcp_iface(&name);
        }
    }
}

fn is_wired_iface(name: &str, dir: &Path) -> bool {
    if name == "lo" || name == "lo0" {
        return false;
    }
    if dir.join("wireless").exists() || dir.join("phy80211").exists() {
        return false;
    }
    true
}

/// The interface is admin-up (IFF_UP in sysfs `flags`). Unknown counts as
/// down, so it is brought up as before.
fn admin_up(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("flags"))
        .ok()
        .and_then(|s| u32::from_str_radix(s.trim().trim_start_matches("0x"), 16).ok())
        .is_some_and(|flags| flags & libc::IFF_UP as u32 != 0)
}

fn read_carrier(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("carrier"))
        .ok()
        .is_some_and(|s| s.trim() == "1")
}

/// Bring the interface admin-up so sysfs carrier becomes readable after plug-in.
pub(crate) fn bring_iface_up(iface: &str) {
    if !can_manage_interfaces() {
        return;
    }
    let _ = Command::new("ip")
        .args(["link", "set", "dev", iface, "up"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn dhcp_client_cmds(iface: &str) -> [(&'static str, Vec<String>); 3] {
    [
        (
            "udhcpc",
            // Keep retries short; watch_link_up re-runs while carrier stays up.
            vec!["-i", iface, "-n", "-q", "-t", "3"]
                .into_iter()
                .map(String::from)
                .collect(),
        ),
        ("dhcpcd", vec!["-n".into(), iface.to_string()]),
        ("dhclient", vec![iface.to_string()]),
    ]
}

/// DHCP succeeded only when the client process exited 0. A missing binary or a
/// non-zero exit (failed udhcpc) must fall through to dhcpcd/dhclient.
/// `has_usable_ipv4` is address evidence after that client ran.
pub(crate) fn dhcp_client_ok(
    status: Result<ExitStatus, std::io::Error>,
    has_usable_ipv4: bool,
) -> bool {
    status.ok().is_some_and(|s| s.success()) && has_usable_ipv4
}

fn first_successful_dhcp_client(
    clients: &[(&str, Vec<String>)],
    mut has_usable_ipv4: impl FnMut() -> bool,
) -> Option<usize> {
    for (i, (bin, args)) in clients.iter().enumerate() {
        let status = Command::new(bin)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if dhcp_client_ok(status, has_usable_ipv4()) {
            return Some(i);
        }
    }
    None
}

fn iface_has_usable_ipv4(iface: &str) -> bool {
    // Kernel can't be asked: do not block on address evidence; exit 0 is enough.
    crate::net::ipv4_addrs(Some(iface)).is_none_or(|ips| !ips.is_empty())
}

fn dhcp_iface(iface: &str) {
    if !can_manage_interfaces() {
        return;
    }
    let cmds = dhcp_client_cmds(iface);
    let clients: Vec<(&str, Vec<String>)> = cmds.into_iter().collect();
    let _ = first_successful_dhcp_client(&clients, || iface_has_usable_ipv4(iface));
}

/// Watch sysfs carrier and request DHCP when a cable starts carrying a link,
/// and retry while carrier stays up without a usable IPv4.
/// When `wake_connect` is set, wake the Connect poll loop on a rising carrier
/// edge **or** when a usable IPv4 appears (DHCP/internet arrived after boot
/// with the cable already in — carrier edge alone misses that case).
pub fn watch_link_up(
    stop: std::sync::Arc<AtomicBool>,
    wake_connect: Option<std::sync::Arc<crate::net::connect::PollWake>>,
) {
    let mut last: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();
    let mut last_had_addr: std::collections::BTreeMap<String, bool> =
        std::collections::BTreeMap::new();
    let mut last_attempt: std::collections::BTreeMap<String, Instant> =
        std::collections::BTreeMap::new();
    // Opened before the first look so no change between looks is missed.
    let events = LinkEvents::open();
    while !stop.load(Ordering::Relaxed) {
        let sys = Path::new("/sys/class/net");
        let mut seen = std::collections::BTreeSet::new();
        let mut waiting_for_addr = false;
        if let Ok(entries) = std::fs::read_dir(sys) {
            for entry in entries.flatten() {
                let dir = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if !is_wired_iface(&name, &dir) {
                    continue;
                }
                seen.insert(name.clone());
                let is_new = !last.contains_key(&name);
                if is_new || !admin_up(&dir) {
                    bring_iface_up(&name);
                }
                let carrier = read_carrier(&dir);
                let was = last.get(&name).copied().unwrap_or(false);
                let rising = carrier && (!was || is_new);
                // Only a link that carries can have a usable address.
                let has_addr = carrier && iface_has_usable_ipv4(&name);
                let previously_had_addr = last_had_addr.get(&name).copied().unwrap_or(false);
                let acquired_ipv4 = carrier && has_addr && !previously_had_addr;
                let needs_addr = carrier && !has_addr;
                waiting_for_addr |= needs_addr;
                let due = last_attempt
                    .get(&name)
                    .is_none_or(|t| t.elapsed() >= RETRY_WHILE_UP);
                if needs_addr && (rising || due) {
                    dhcp_iface(&name);
                    last_attempt.insert(name.clone(), Instant::now());
                }
                if should_wake_connect_poll(rising, acquired_ipv4)
                    && let Some(wake) = &wake_connect
                {
                    wake.wake();
                }
                if !carrier {
                    last_attempt.remove(&name);
                }
                last.insert(name.clone(), carrier);
                last_had_addr.insert(name, carrier && has_addr);
            }
        }
        // Drop state for interfaces that disappeared.
        last.retain(|k, _| seen.contains(k));
        last_had_addr.retain(|k, _| seen.contains(k));
        last_attempt.retain(|k, _| seen.contains(k));
        // Look again soon while an address is awaited; otherwise sleep until
        // the kernel reports a link or address change. A new or downed
        // interface sends one too, and dropped events (ENOBUFS) count as one,
        // so no timer backs this up (D3: an idle Luna stays asleep). At
        // shutdown the thread is left asleep; the process exit ends it.
        match &events {
            Some(events) if !waiting_for_addr => events.wait_forever(),
            _ => std::thread::sleep(LOOK_EVERY),
        }
    }
}

/// Link and IPv4 address changes from the kernel (rtnetlink), so the watcher
/// can sleep instead of reading sysfs every two seconds. The HDMI console
/// opens its own (each socket gets every event).
pub(crate) struct LinkEvents {
    fd: std::os::fd::OwnedFd,
}

impl LinkEvents {
    fn open() -> Option<Self> {
        Self::open_groups((libc::RTMGRP_LINK | libc::RTMGRP_IPV4_IFADDR) as u32)
    }

    /// Subscribe to these `RTMGRP_*` multicast groups.
    pub(crate) fn open_groups(groups: u32) -> Option<Self> {
        use std::os::fd::FromRawFd;
        // SAFETY: plain socket call; the fd is owned below.
        let raw = unsafe {
            libc::socket(
                libc::AF_NETLINK,
                libc::SOCK_RAW | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
                libc::NETLINK_ROUTE,
            )
        };
        if raw < 0 {
            return None;
        }
        // SAFETY: `raw` is a fresh fd nobody else owns.
        let fd = unsafe { std::os::fd::OwnedFd::from_raw_fd(raw) };
        // SAFETY: zeroed sockaddr_nl is a valid value.
        let mut addr: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
        addr.nl_family = libc::AF_NETLINK as libc::sa_family_t;
        addr.nl_groups = groups;
        // SAFETY: `addr` is a valid sockaddr_nl of the given size.
        let bound = unsafe {
            libc::bind(
                std::os::fd::AsRawFd::as_raw_fd(&fd),
                &addr as *const libc::sockaddr_nl as *const libc::sockaddr,
                std::mem::size_of::<libc::sockaddr_nl>() as libc::socklen_t,
            )
        };
        (bound == 0).then_some(Self { fd })
    }

    /// Wait for a change with no timeout, then drain what arrived. A failed
    /// wait (only an interrupt is expected) returns after 10 s, so a broken
    /// socket degrades to looking every 10 s instead of spinning.
    pub(crate) fn wait_forever(&self) {
        if !self.wait_ms(-1) {
            std::thread::sleep(Duration::from_secs(10));
        }
    }

    /// True when something arrived (and was drained) within `ms` (-1: no limit).
    fn wait_ms(&self, ms: i32) -> bool {
        use std::os::fd::AsRawFd;
        let fd = self.fd.as_raw_fd();
        let mut pfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        if unsafe { libc::poll(&mut pfd, 1, ms) } <= 0 {
            return false;
        }
        let mut buf = [0u8; 8192];
        for _ in 0..1024 {
            // SAFETY: `buf` is writable for its length.
            let n =
                unsafe { libc::recv(fd, buf.as_mut_ptr().cast(), buf.len(), libc::MSG_DONTWAIT) };
            if n > 0 {
                continue;
            }
            // ENOBUFS: events were dropped; the look that follows catches up.
            if n < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOBUFS) {
                continue;
            }
            break;
        }
        true
    }
}

/// Wake Connect when link rises or when a usable IPv4 appears on an already-up
/// link (DHCP arrived late — carrier edge alone misses that case).
pub(crate) fn should_wake_connect_poll(rising_carrier: bool, acquired_ipv4: bool) -> bool {
    rising_carrier || acquired_ipv4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_on_wired_skips_wifi() {
        let root = tempfile::tempdir().unwrap();
        let net = root.path().join("sys/class/net");
        let eth = net.join("eth0");
        std::fs::create_dir_all(&eth).unwrap();
        std::fs::write(eth.join("carrier"), "1").unwrap();
        let wlan = net.join("wlan0");
        std::fs::create_dir_all(wlan.join("wireless")).unwrap();
        std::fs::write(wlan.join("carrier"), "1").unwrap();
        // Should not panic when dhcp binaries are missing.
        request_on_wired(&net);
    }

    #[test]
    fn missing_binary_is_not_ok() {
        let status = Command::new("/no/such/udhcpc-luna-dhcp-test").status();
        assert!(!dhcp_client_ok(status, true));
    }

    #[test]
    fn nonzero_exit_is_not_ok() {
        let status = Command::new("false").status();
        assert!(!dhcp_client_ok(status, true));
    }

    #[test]
    fn success_without_ipv4_is_not_ok() {
        let status = Command::new("true").status();
        assert!(!dhcp_client_ok(status, false));
    }

    #[test]
    fn success_with_ipv4_is_ok() {
        let status = Command::new("true").status();
        assert!(dhcp_client_ok(status, true));
    }

    #[test]
    fn failed_udhcpc_falls_through_to_next_client() {
        let clients: Vec<(&str, Vec<String>)> =
            vec![("false", vec![]), ("true", vec![]), ("true", vec![])];
        assert_eq!(first_successful_dhcp_client(&clients, || true), Some(1));
    }

    #[test]
    fn stops_at_first_success() {
        let clients: Vec<(&str, Vec<String>)> = vec![("true", vec![]), ("false", vec![])];
        let winner = first_successful_dhcp_client(&clients, || true);
        assert_eq!(winner, Some(0));
    }

    #[test]
    fn is_wired_skips_lo_and_wifi() {
        let root = tempfile::tempdir().unwrap();
        let lo = root.path().join("lo");
        std::fs::create_dir_all(&lo).unwrap();
        assert!(!is_wired_iface("lo", &lo));
        let wlan = root.path().join("wlan0");
        std::fs::create_dir_all(wlan.join("wireless")).unwrap();
        assert!(!is_wired_iface("wlan0", &wlan));
        let eth = root.path().join("eth0");
        std::fs::create_dir_all(&eth).unwrap();
        assert!(is_wired_iface("eth0", &eth));
    }

    #[test]
    fn wake_connect_on_rising_carrier_or_acquired_ipv4() {
        assert!(should_wake_connect_poll(true, false));
        assert!(should_wake_connect_poll(false, true));
        assert!(should_wake_connect_poll(true, true));
        assert!(
            !should_wake_connect_poll(false, false),
            "steady carrier with no new address must not spuriously wake"
        );
    }

    #[test]
    fn bring_iface_up_does_not_panic_on_bogus_iface() {
        bring_iface_up("nonexistent_test_iface");
    }
}
