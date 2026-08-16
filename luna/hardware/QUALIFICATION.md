# Luna hardware qualification — Wi-Fi & Bluetooth (BOM lock)

The Dell Wyse 5020 has no Wi-Fi or Bluetooth. Batch 1 adds two USB 2.0
dongles; both USB 3.0 ports remain dedicated to storage drives.

## Requirements
- Works on Alpine (musl) with in-tree or distro-packaged firmware, **no
  out-of-tree DKMS** — Luna OS must not need a compiler or internet at install.
- Wi-Fi: station mode required; **AP mode preferred** for the "Luna Setup"
  iOS-safe fallback (needs `hostapd` support on the chipset).
- BLE: BlueZ peripheral + advertising, used by Luna Mobile for HTTP-over-BLE
  setup (same protocol as LibreServ).
- Both dongles must idle at low power (the whole box targets ~7-9 W).

## Candidate chipsets to test (order by preference)
| Chipset | Wi-Fi | AP mode | Notes |
|---|---|---|---|
| mt76 (MediaTek mt7612u/mt7921au) | yes | yes | modern, mainline, dual-band |
| ath9k_htc (AR9271) | yes | limited | rock solid, 2.4 GHz only |
| rt2800usb | yes | yes | common, older |
| CSR8510 | — (BT) | — | ubiquitous BLE, verify BlueZ 5.6x pairing/peripheral |
| Realtek RTL8761B | — (BT) | — | often better behaved than CSR clones |

## Qualification checklist (each candidate)
1. `lsusb` identifies device; correct kernel module autoloads on Alpine.
2. `ip link` shows interface after cold boot, no firmware download needed.
3. `wpa_supplicant -Dnl80211` scan finds a 2.4 GHz and 5 GHz network.
4. Associate + DHCP in <10 s; reconnect after router reboot and after USB replug.
5. AP mode (if claimed): `hostapd` starts, phone associates, Luna serves setup UI.
6. BLE: BlueZ advertises the Luna GATT service; Android companion proxies HTTP.
7. Soak: 24 h connected, <1% packet loss, no USB reset storms in dmesg.

## Decision
- Lock the BOM only after both dongles pass 1-7 on a real Wyse 5020.
- If no AP-capable Wi-Fi candidate passes, Batch 1 ships with Ethernet cable
  as the iOS setup path and AP mode is re-evaluated next hardware revision.
