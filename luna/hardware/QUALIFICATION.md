# Luna hardware qualification — Wi-Fi (BOM lock)

The Dell Wyse 3040 has no usable onboard Wi-Fi for Luna's setup path.
Batch 1 adds one USB 2.0 Wi-Fi dongle; USB 3.0 ports remain dedicated to
storage drives.

## Requirements
- Works on Alpine (musl) with in-tree or distro-packaged firmware, **no
  out-of-tree DKMS** — Luna OS must not need a compiler or internet at install.
- Station mode required so Luna can join the home network.
- **AP mode required** for first-run setup without a cable: Luna broadcasts
  an open "Luna Setup" network (`hostapd`) so a phone can open the wizard.
- The dongle must idle at low power (the whole box targets ~7-9 W).

## Candidate chipsets to test (order by preference)
| Chipset | Wi-Fi | AP mode | Notes |
|---|---|---|---|
| mt76 (MediaTek mt7612u/mt7921au) | yes | yes | modern, mainline, dual-band |
| ath9k_htc (AR9271) | yes | limited | rock solid, 2.4 GHz only |
| rt2800usb | yes | yes | common, older |

## Qualification checklist (each candidate)
1. `lsusb` identifies device; correct kernel module autoloads on Alpine.
2. `ip link` shows interface after cold boot, no firmware download needed.
3. `wpa_supplicant -Dnl80211` scan finds a 2.4 GHz and 5 GHz network.
4. Associate + DHCP in <10 s; reconnect after router reboot and after USB replug.
5. AP mode: `hostapd` starts, phone associates, Luna serves the setup wizard.
6. Soak: 24 h connected, <1% packet loss, no USB reset storms in dmesg.

## Decision
- Lock the BOM only after a Wi-Fi dongle passes 1-7 on a real Wyse 3040.
- If no AP-capable Wi-Fi candidate passes, Batch 1 ships with Ethernet cable
  as the setup path and AP mode is re-evaluated next hardware revision.
