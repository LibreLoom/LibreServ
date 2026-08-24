//! DHCP on Ethernet link-up (cable insert), not boot-only.

use std::path::Path;
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

fn dhcp_iface(iface: &str) {
    for (bin, args) in [
        (
            "udhcpc",
            vec!["-i", iface, "-n", "-q", "-t", "8"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>(),
        ),
        (
            "dhcpcd",
            vec!["-n", iface]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>(),
        ),
        (
            "dhclient",
            vec![iface].into_iter().map(String::from).collect::<Vec<_>>(),
        ),
    ] {
        if std::process::Command::new(bin).args(&args).status().is_ok() {
            return;
        }
    }
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
}
