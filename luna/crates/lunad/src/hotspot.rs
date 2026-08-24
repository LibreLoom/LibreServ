//! Setup AP is removed. Uplink is Ethernet only.

use serde::Serialize;

pub const SETUP_SSID: &str = "";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct HotspotStatus {
    pub available: bool,
    pub running: bool,
    pub interface: Option<String>,
    pub ssid: String,
}

pub fn should_start_setup_hotspot(
    _setup_completed: bool,
    _ethernet_connected: bool,
    _wifi_connected: bool,
) -> bool {
    false
}

pub fn wifi_uplink_connected(wifi: &dyn crate::wifi::WifiProvider) -> bool {
    wifi.status().map(|st| st.connected).unwrap_or(false)
}

/// Kept so older call sites compile. Start always fails — there is no setup AP.
pub struct CommandHotspot;

impl CommandHotspot {
    pub fn new(_iface: impl Into<String>, _run_dir: &std::path::Path) -> Self {
        Self
    }
    pub fn start(&self) -> Result<(), String> {
        Err("Luna uses a cable. There is no setup Wi-Fi network.".into())
    }
    pub fn stop(&self) -> Result<(), String> {
        Ok(())
    }
    pub fn status(&self) -> HotspotStatus {
        HotspotStatus {
            available: false,
            running: false,
            interface: None,
            ssid: String::new(),
        }
    }
    pub fn set_cache(&self, _networks: Vec<crate::wifi::WifiNetwork>) {}
    pub fn cached_scan(&self) -> Vec<crate::wifi::WifiNetwork> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_starts_a_setup_access_point() {
        assert!(!should_start_setup_hotspot(false, false, false));
        assert!(!should_start_setup_hotspot(true, false, false));
    }
}
