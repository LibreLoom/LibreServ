//! DHCP on Ethernet link-up (cable insert), not boot-only.

use std::path::Path;
use std::process::{Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Run DHCP on every non-wireless interface that has carrier and no IPv4 yet.
pub fn request_on_wired(sys_net: &Path) {
    let Ok(entries) = std::fs::read_dir(sys_net) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "lo" || name == "lo0" {
            continue;
        }
        if dir.join("wireless").exists() || dir.join("phy80211").exists() {
            continue;
        }
        let carrier = std::fs::read_to_string(dir.join("carrier"))
            .ok()
            .is_some_and(|s| s.trim() == "1");
        if !carrier {
            continue;
        }
        dhcp_iface(&name);
    }
}

fn dhcp_client_cmds(iface: &str) -> [(&'static str, Vec<String>); 3] {
    [
        (
            "udhcpc",
            // Keep retries short; watch_link_up re-runs on carrier edges.
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

/// Watch sysfs carrier and request DHCP when a cable starts carrying a link.
pub fn watch_link_up(stop: std::sync::Arc<AtomicBool>) {
    let mut last: std::collections::BTreeMap<String, bool> = std::collections::BTreeMap::new();
    while !stop.load(Ordering::Relaxed) {
        let sys = Path::new("/sys/class/net");
        if let Ok(entries) = std::fs::read_dir(sys) {
            for entry in entries.flatten() {
                let dir = entry.path();
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == "lo" {
                    continue;
                }
                if dir.join("wireless").exists() || dir.join("phy80211").exists() {
                    continue;
                }
                let carrier = std::fs::read_to_string(dir.join("carrier"))
                    .ok()
                    .is_some_and(|s| s.trim() == "1");
                let was = last.get(&name).copied().unwrap_or(false);
                if carrier && !was {
                    dhcp_iface(&name);
                }
                last.insert(name, carrier);
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
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
    fn missing_binary_is_not_success() {
        let status = Command::new("/no/such/udhcpc-luna-dhcp-test").status();
        assert!(!dhcp_client_ok(status, true));
    }

    #[test]
    fn nonzero_exit_is_not_success_even_with_an_address() {
        let status = Command::new("false").status();
        assert!(!dhcp_client_ok(status, true));
    }

    #[test]
    fn zero_exit_without_address_is_not_success() {
        let status = Command::new("true").status();
        assert!(!dhcp_client_ok(status, false));
    }

    #[test]
    fn zero_exit_with_address_is_success() {
        let status = Command::new("true").status();
        assert!(dhcp_client_ok(status, true));
    }

    #[test]
    fn failed_udhcpc_falls_through_to_next_client() {
        let clients = [("false", vec![]), ("true", vec![])];
        assert_eq!(first_successful_dhcp_client(&clients, || true), Some(1));
    }

    #[test]
    fn first_client_zero_exit_without_addr_still_falls_through() {
        let clients = [("true", vec![]), ("true", vec![])];
        let mut checks = 0u8;
        let winner = first_successful_dhcp_client(&clients, || {
            checks += 1;
            checks >= 2
        });
        assert_eq!(winner, Some(1));
        assert_eq!(checks, 2);
    }
}
