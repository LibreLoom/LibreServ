//! DHCP on Ethernet link-up (cable insert), not boot-only.

use std::path::Path;
use std::process::{Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const RETRY_WHILE_UP: Duration = Duration::from_secs(10);

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

fn read_carrier(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join("carrier"))
        .ok()
        .is_some_and(|s| s.trim() == "1")
}

/// Bring the interface admin-up so sysfs carrier becomes readable after plug-in.
pub(crate) fn bring_iface_up(iface: &str) {
    let _ = Command::new("ip")
        .args(["link", "set", "dev", iface, "up"])
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
        let status = Command::new(bin).args(args).status();
        if dhcp_client_ok(status, has_usable_ipv4()) {
            return Some(i);
        }
    }
    None
}

fn iface_has_usable_ipv4(iface: &str) -> bool {
    match Command::new("ip")
        .args(["-4", "-o", "addr", "show", "dev", iface])
        .output()
    {
        Ok(out) if out.status.success() => {
            crate::net::parse_ip_dash_o(&String::from_utf8_lossy(&out.stdout))
                .iter()
                .any(|ip| !ip.is_empty())
        }
        Ok(_) => false,
        // `ip` missing: do not block on address evidence; exit 0 is enough.
        Err(_) => true,
    }
}

fn dhcp_iface(iface: &str) {
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
    wake_connect: Option<std::sync::Arc<AtomicBool>>,
) {
    let mut last: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();
    let mut last_had_addr: std::collections::BTreeMap<String, bool> =
        std::collections::BTreeMap::new();
    let mut last_attempt: std::collections::BTreeMap<String, Instant> =
        std::collections::BTreeMap::new();
    while !stop.load(Ordering::Relaxed) {
        let sys = Path::new("/sys/class/net");
        let mut seen = std::collections::BTreeSet::new();
        if let Ok(entries) = std::fs::read_dir(sys) {
            for entry in entries.flatten() {
                let dir = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if !is_wired_iface(&name, &dir) {
                    continue;
                }
                seen.insert(name.clone());
                let is_new = !last.contains_key(&name);
                bring_iface_up(&name);
                let carrier = read_carrier(&dir);
                let was = last.get(&name).copied().unwrap_or(false);
                let rising = carrier && (!was || is_new);
                let has_addr = iface_has_usable_ipv4(&name);
                let previously_had_addr = last_had_addr.get(&name).copied().unwrap_or(false);
                let acquired_ipv4 = carrier && has_addr && !previously_had_addr;
                let needs_addr = carrier && !has_addr;
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
                    wake.store(true, Ordering::Relaxed);
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
        std::thread::sleep(Duration::from_secs(2));
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
}
