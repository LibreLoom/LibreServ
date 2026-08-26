//! Network status from sysfs and /proc.
//!
//! No dbus, no netlink, no external commands: this reads `carrier` files under
//! `/sys/class/net` and the kernel routing table from `/proc/net/route`. That
//! is enough for the setup wizard's connection check on Luna OS.

use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct InterfaceStatus {
    pub name: String,
    pub carrier: bool,
    pub wireless: bool,
    pub operstate: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NetworkStatus {
    pub ethernet_connected: bool,
    pub wifi_interface: Option<String>,
    pub wifi_connected: bool,
    pub has_default_route: bool,
    pub ipv4: Vec<String>,
    pub interfaces: Vec<InterfaceStatus>,
}

const DEV_MOCK_IPV4: &str = "192.168.1.20";

/// Dev-only: pretend a cable is in when sysfs has no wired link. Enabled when
/// `LUNA_DATA_DIR` ends in `/dev` (Cloud Agent / `make dev-daemon`) or
/// `LUNA_MOCK_ETHERNET=1`.
fn dev_mock_ethernet_enabled() -> bool {
    if std::env::var("LUNA_MOCK_ETHERNET")
        .ok()
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    {
        return true;
    }
    std::env::var("LUNA_DATA_DIR")
        .ok()
        .is_some_and(|d| d.ends_with("/dev") || d.ends_with("\\dev"))
}

fn apply_dev_mock(mut status: NetworkStatus) -> NetworkStatus {
    status.ethernet_connected = true;
    status.has_default_route = true;
    if status.ipv4.is_empty() {
        status.ipv4.push(DEV_MOCK_IPV4.to_string());
    }
    status
}

pub fn read_status(sys_net: &Path, proc_route: &str) -> NetworkStatus {
    let mut interfaces = Vec::new();
    let Ok(entries) = std::fs::read_dir(sys_net) else {
        return NetworkStatus {
            ethernet_connected: false,
            wifi_interface: None,
            wifi_connected: false,
            has_default_route: default_route(proc_route).is_some(),
            ipv4: Vec::new(),
            interfaces,
        };
    };

    for entry in entries.flatten() {
        let dir = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "lo" || name == "lo0" {
            continue;
        }
        // cfg80211 (Intel iwlwifi, mt76, …) exposes phy80211; older WEXT
        // drivers expose wireless. Alpine's wpa_supplicant checks both.
        let wireless = is_wireless(&dir);
        let carrier = read_trimmed(&dir.join("carrier")).as_deref() == Some("1");
        let operstate = read_trimmed(&dir.join("operstate")).unwrap_or_default();
        interfaces.push(InterfaceStatus {
            name: name.clone(),
            carrier,
            wireless,
            operstate,
        });
    }

    interfaces.sort_by(|a, b| a.name.cmp(&b.name));
    let ethernet_connected = interfaces
        .iter()
        .any(|i| !i.wireless && (i.carrier || i.operstate == "up"));
    let wifi_interface = interfaces
        .iter()
        .find(|i| i.wireless)
        .map(|i| i.name.clone());
    let wifi_connected = interfaces.iter().any(|i| i.wireless && i.carrier);
    let route_iface = default_route(proc_route);

    let status = NetworkStatus {
        ethernet_connected,
        wifi_interface,
        wifi_connected,
        has_default_route: route_iface.is_some(),
        ipv4: live_ipv4(),
        interfaces,
    };
    if !status.ethernet_connected && dev_mock_ethernet_enabled() {
        return apply_dev_mock(status);
    }
    status
}

/// Current IPv4 addresses on non-loopback interfaces (never the old 169.254 product address).
pub fn live_ipv4() -> Vec<String> {
    let out = std::process::Command::new("ip")
        .args(["-4", "-o", "addr", "show"])
        .output()
        .ok();
    let text = out
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    parse_ip_dash_o(&text)
}

pub fn parse_ip_dash_o(text: &str) -> Vec<String> {
    let mut ips = Vec::new();
    for line in text.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        let Some(inet_idx) = parts.iter().position(|p| *p == "inet") else {
            continue;
        };
        let Some(cidr) = parts.get(inet_idx + 1) else {
            continue;
        };
        let ip = cidr.split('/').next().unwrap_or("");
        if ip.is_empty() || ip.starts_with("127.") || ip.starts_with("169.254.") {
            continue;
        }
        if !ips.iter().any(|e| e == ip) {
            ips.push(ip.to_string());
        }
    }
    ips
}

/// Parse `/proc/net/route` for the interface with a zero-destination route.
pub fn default_route(proc_route: &str) -> Option<String> {
    let mut lines = proc_route.lines();
    let mut columns: BTreeMap<&str, usize> = BTreeMap::new();
    if let Some(header) = lines.next() {
        for (idx, col) in header.split_whitespace().enumerate() {
            columns.insert(col, idx);
        }
    }
    let iface_idx = *columns.get("Iface")?;
    let dest_idx = *columns.get("Destination")?;
    for line in lines {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() <= iface_idx.max(dest_idx) {
            continue;
        }
        if fields
            .get(dest_idx)
            .map(|d| *d == "00000000")
            .unwrap_or(false)
        {
            return Some(fields[iface_idx].to_string());
        }
    }
    None
}

fn is_wireless(iface_dir: &Path) -> bool {
    iface_dir.join("wireless").exists() || iface_dir.join("phy80211").exists()
}

fn read_trimmed(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let t = raw.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fake_sys(root: &Path) -> std::path::PathBuf {
        let net = root.join("sys/class/net");
        for (name, carrier, wireless, oper) in
            [("eth0", "1", false, "up"), ("wlan0", "0", true, "down")]
        {
            let dir = net.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("carrier"), carrier).unwrap();
            fs::write(dir.join("operstate"), oper).unwrap();
            if wireless {
                fs::create_dir_all(dir.join("wireless")).unwrap();
            }
        }
        net
    }

    #[test]
    fn detects_ethernet_and_wifi_interfaces() {
        let root = tempfile::tempdir().unwrap();
        let net = fake_sys(root.path());
        let status = read_status(
            &net,
            "Iface\tDestination\tGateway\neth0\t00000000\t0101A8C0\n",
        );
        assert!(status.ethernet_connected);
        assert_eq!(status.wifi_interface.as_deref(), Some("wlan0"));
        assert!(!status.wifi_connected);
        assert!(status.has_default_route);
        assert_eq!(
            parse_ip_dash_o("2: eth0    inet 192.168.1.20/24 brd 192.168.1.255\n").as_slice(),
            ["192.168.1.20"]
        );
        assert!(parse_ip_dash_o("2: eth0    inet 169.254.42.42/16\n").is_empty());
        assert_eq!(
            default_route("Iface\tDestination\neth0\t00000000\n").as_deref(),
            Some("eth0")
        );
    }

    #[test]
    fn detects_cfg80211_wifi_via_phy80211() {
        let root = tempfile::tempdir().unwrap();
        let net = root.path().join("sys/class/net");
        let eth = net.join("enp0s31f6");
        fs::create_dir_all(&eth).unwrap();
        fs::write(eth.join("carrier"), "1").unwrap();
        fs::write(eth.join("operstate"), "up").unwrap();
        let wlan = net.join("wlp2s0");
        fs::create_dir_all(&wlan).unwrap();
        fs::write(wlan.join("carrier"), "0").unwrap();
        fs::write(wlan.join("operstate"), "down").unwrap();
        // Intel iwlwifi: phy80211 only, no legacy wireless/ node.
        fs::create_dir_all(wlan.join("phy80211")).unwrap();

        let status = read_status(&net, "Iface\tDestination\n");
        assert!(status.ethernet_connected);
        assert_eq!(status.wifi_interface.as_deref(), Some("wlp2s0"));
        assert!(!status.wifi_connected);
    }

    #[test]
    fn empty_proc_route_has_no_default() {
        assert_eq!(default_route("Iface\tDestination\neth0\t01000000\n"), None);
    }

    #[test]
    fn dev_mock_marks_cable_in_with_ipv4() {
        let status = apply_dev_mock(NetworkStatus {
            ethernet_connected: false,
            wifi_interface: None,
            wifi_connected: false,
            has_default_route: false,
            ipv4: Vec::new(),
            interfaces: Vec::new(),
        });
        assert!(status.ethernet_connected);
        assert!(status.has_default_route);
        assert_eq!(status.ipv4, ["192.168.1.20"]);
    }

    #[test]
    fn dev_mock_keeps_live_ipv4_when_present() {
        let status = apply_dev_mock(NetworkStatus {
            ethernet_connected: false,
            wifi_interface: None,
            wifi_connected: false,
            has_default_route: true,
            ipv4: vec!["10.0.0.5".into()],
            interfaces: Vec::new(),
        });
        assert_eq!(status.ipv4, ["10.0.0.5"]);
    }
}
