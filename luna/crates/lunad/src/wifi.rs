//! Wi-Fi provider abstraction.
//!
//! Luna OS uses wpa_supplicant through `wpa_cli` (no dbus dependency).
//! LibreServ can later add a NetworkManager provider behind the same trait.
//! Passphrases are passed to wpa_supplicant and never logged or returned.

use std::process::Command;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WifiNetwork {
    pub ssid: String,
    pub signal: i32,
    pub encrypted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WifiStatus {
    pub available: bool,
    pub connected: bool,
    pub ssid: Option<String>,
    pub ip_address: Option<String>,
    pub state: String,
}

#[derive(Debug, thiserror::Error)]
pub enum WifiError {
    #[error("Wi-Fi isn't available on this device.")]
    Unavailable,
    #[error("That password didn't work. Check the sticker on your internet box and try again.")]
    Auth,
    #[error("That network name or password has characters Luna can't use. Try another.")]
    InvalidInput,
    #[error("Could not reach the Wi-Fi tool: {0}")]
    Io(#[source] std::io::Error),
    #[error("The Wi-Fi tool said: {0}")]
    Tool(String),
}

pub trait WifiProvider: Send + Sync {
    fn scan(&self) -> Result<Vec<WifiNetwork>, WifiError>;
    fn connect(&self, ssid: &str, passphrase: &str) -> Result<(), WifiError>;
    fn status(&self) -> Result<WifiStatus, WifiError>;
    fn forget(&self) -> Result<(), WifiError>;
}

/// Provider for headless systems using `wpa_cli`.
pub struct WpaCliProvider {
    interface: String,
}

impl WpaCliProvider {
    pub fn new(interface: impl Into<String>) -> Self {
        Self {
            interface: interface.into(),
        }
    }

    fn run(&self, args: &[&str]) -> Result<String, WifiError> {
        let out = Command::new("wpa_cli")
            .arg("-i")
            .arg(&self.interface)
            .args(args)
            .output()
            .map_err(WifiError::Io)?;
        if !out.status.success() {
            return Err(WifiError::Tool(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

impl WifiProvider for WpaCliProvider {
    fn scan(&self) -> Result<Vec<WifiNetwork>, WifiError> {
        self.run(&["scan"])?;
        // wpa_supplicant reports results asynchronously; a short settle is required.
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let output = self.run(&["scan_results"])?;
        Ok(parse_scan_results(&output))
    }

    fn connect(&self, ssid: &str, passphrase: &str) -> Result<(), WifiError> {
        let ssid_q = wpa_cli_quoted(ssid)?;
        let id = self.run(&["add_network"])?.trim().to_string();
        self.run(&["set_network", &id, "ssid", &ssid_q])?;
        if passphrase.is_empty() {
            self.run(&["set_network", &id, "key_mgmt", "NONE"])?;
        } else {
            let psk_q = wpa_cli_quoted(passphrase)?;
            self.run(&["set_network", &id, "psk", &psk_q])?;
        }
        self.run(&["enable_network", &id])?;
        self.run(&["select_network", &id])?;
        let _ = self.run(&["save_config"]);

        // Verify the association actually completed.
        std::thread::sleep(std::time::Duration::from_millis(3000));
        let status = self.status()?;
        if status.connected {
            Ok(())
        } else {
            Err(WifiError::Auth)
        }
    }

    fn status(&self) -> Result<WifiStatus, WifiError> {
        let output = self.run(&["status"])?;
        let mut ssid = None;
        let mut ip = None;
        let mut state = "unknown".to_string();
        for line in output.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            match key {
                "ssid" => ssid = Some(value.to_string()),
                "ip_address" => ip = Some(value.to_string()),
                "wpa_state" => state = value.to_string(),
                _ => {}
            }
        }
        let connected = state == "COMPLETED";
        Ok(WifiStatus {
            available: true,
            connected,
            ssid,
            ip_address: ip,
            state,
        })
    }

    fn forget(&self) -> Result<(), WifiError> {
        let output = self.run(&["status"])?;
        for line in output.lines() {
            if let Some((key, value)) = line.split_once('=')
                && key == "id"
            {
                self.run(&["remove_network", value])?;
                let _ = self.run(&["save_config"]);
                return Ok(());
            }
        }
        Ok(())
    }
}

/// Used when no wireless interface or wpa_cli exists.
pub struct NoopProvider;

impl WifiProvider for NoopProvider {
    fn scan(&self) -> Result<Vec<WifiNetwork>, WifiError> {
        Err(WifiError::Unavailable)
    }
    fn connect(&self, _ssid: &str, _passphrase: &str) -> Result<(), WifiError> {
        Err(WifiError::Unavailable)
    }
    fn status(&self) -> Result<WifiStatus, WifiError> {
        Ok(WifiStatus {
            available: false,
            connected: false,
            ssid: None,
            ip_address: None,
            state: "unavailable".into(),
        })
    }
    fn forget(&self) -> Result<(), WifiError> {
        Err(WifiError::Unavailable)
    }
}

/// Deterministic provider for tests.
#[derive(Default)]
pub struct MockProvider {
    pub networks: Mutex<Vec<WifiNetwork>>,
    pub connected_ssid: Mutex<Option<String>>,
    pub connect_calls: Mutex<Vec<(String, String)>>,
}

impl WifiProvider for MockProvider {
    fn scan(&self) -> Result<Vec<WifiNetwork>, WifiError> {
        Ok(self.networks.lock().unwrap().clone())
    }
    fn connect(&self, ssid: &str, passphrase: &str) -> Result<(), WifiError> {
        self.connect_calls
            .lock()
            .unwrap()
            .push((ssid.to_string(), passphrase.to_string()));
        *self.connected_ssid.lock().unwrap() = Some(ssid.to_string());
        Ok(())
    }
    fn status(&self) -> Result<WifiStatus, WifiError> {
        let ssid = self.connected_ssid.lock().unwrap().clone();
        Ok(WifiStatus {
            available: true,
            connected: ssid.is_some(),
            ssid: ssid.clone(),
            ip_address: Some("192.168.1.42".into()),
            state: if ssid.is_some() {
                "COMPLETED".into()
            } else {
                "DISCONNECTED".into()
            },
        })
    }
    fn forget(&self) -> Result<(), WifiError> {
        *self.connected_ssid.lock().unwrap() = None;
        Ok(())
    }
}

/// Quote a value for `wpa_cli set_network`. Reject quotes, backslashes, and
/// newlines so they cannot break out of the quoted argument.
pub(crate) fn wpa_cli_quoted(value: &str) -> Result<String, WifiError> {
    if value
        .chars()
        .any(|c| c == '"' || c == '\\' || c == '\n' || c == '\r' || c == '\0')
    {
        return Err(WifiError::InvalidInput);
    }
    Ok(format!("\"{value}\""))
}

fn parse_scan_results(output: &str) -> Vec<WifiNetwork> {
    let mut networks = Vec::new();
    for line in output.lines().skip(1) {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 5 {
            continue;
        }
        let ssid = cols[4].trim();
        if ssid.is_empty() {
            continue;
        }
        let signal = cols[2].trim().parse().unwrap_or(0);
        let flags = cols[3];
        let encrypted = flags.contains("PSK") || flags.contains("WPA") || flags.contains("WEP");
        networks.push(WifiNetwork {
            ssid: ssid.to_string(),
            signal,
            encrypted,
        });
    }
    networks.sort_by_key(|n| std::cmp::Reverse(n.signal));
    networks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wpa_cli_scan_results() {
        let output = "bssid / frequency / signal level / flags / ssid\n\
                      00:11:22:33:44:55\t2412\t-44\t[WPA2-PSK-CCMP][ESS]\tHome WiFi\n\
                      aa:bb:cc:dd:ee:ff\t2412\t-80\t[ESS]\tCoffee Shop\n";
        let nets = parse_scan_results(output);
        assert_eq!(nets.len(), 2);
        assert_eq!(nets[0].ssid, "Home WiFi");
        assert!(nets[0].encrypted);
        assert_eq!(nets[1].ssid, "Coffee Shop");
        assert!(!nets[1].encrypted);
    }

    #[test]
    fn mock_provider_round_trip() {
        let mock = MockProvider::default();
        mock.networks.lock().unwrap().push(WifiNetwork {
            ssid: "Home".into(),
            signal: -42,
            encrypted: true,
        });
        assert_eq!(mock.scan().unwrap().len(), 1);
        mock.connect("Home", "hunter2").unwrap();
        assert!(mock.status().unwrap().connected);
        mock.forget().unwrap();
        assert!(!mock.status().unwrap().connected);
    }

    #[test]
    fn wpa_cli_quoted_rejects_breakouts() {
        assert_eq!(wpa_cli_quoted("Home WiFi").unwrap(), "\"Home WiFi\"");
        assert!(wpa_cli_quoted("x\"\nset_network").is_err());
        assert!(wpa_cli_quoted("a\\b").is_err());
        assert!(wpa_cli_quoted("line\n2").is_err());
    }
}
