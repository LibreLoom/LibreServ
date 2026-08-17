import { useCallback, useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { AlertCircle, Cable, Check, Eye, EyeOff, Lock, RefreshCw, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";
import api from "../../lib/api";
import Button from "../ui/Button";
import Pill from "../common/Pill";

// A visible network in the wizard's scan list.
const shapeNetwork = (net) => ({
  ssid: net?.ssid || "",
  signal: typeof net?.signal === "number" ? net.signal : -100,
  encrypted: Boolean(net?.encrypted),
});

const signalLabel = (dbm) => {
  if (dbm >= -50) return "Strong";
  if (dbm >= -67) return "Good";
  return "Weak";
};

/**
 * WifiStep — the connection step of the wizard.
 *
 * Rendered inside SetupPage's card shell (bg-secondary, text-primary), so all
 * text uses the primary/ink ramp and the single gray accent — no extra colors.
 *
 * Behavior mirrors the Luna plan:
 *   - Ethernet up  → Wi-Fi is optional; the step offers it and a "use cable" skip.
 *   - Ethernet down → Wi-Fi is required; the user cannot proceed offline.
 * The skip affordance only renders when a cable is actually present, so it's
 * never a dead button; the required state is enforced by SetupPage's gate.
 */
export default function WifiStep({ onConnected, onSkipWifi }) {
  const [status, setStatus] = useState(null);
  const [networks, setNetworks] = useState([]);
  const [scanning, setScanning] = useState(true);
  const [scanError, setScanError] = useState(false);
  const [selected, setSelected] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [hasScannedOnce, setHasScannedOnce] = useState(false);

  const scanTimer = useRef(null);
  const statusTimer = useRef(null);
  const aliveRef = useRef(true);

  const ethernet = Boolean(status?.ethernet_connected);
  const connected = Boolean(status?.connected);
  const available = status ? Boolean(status.available) : true;

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api("/setup/wifi/status", { allowNonOk: true, noRetry: true });
      if (!res.ok) return;
      const data = await res.json();
      if (aliveRef.current) setStatus(data);
    } catch {
      /* transient — keep the last known state */
    }
  }, []);

  const fetchScan = useCallback(async () => {
    if (!aliveRef.current) return;
    setScanning(true);
    try {
      const res = await api("/setup/wifi/scan", { allowNonOk: true, noRetry: true });
      if (!res.ok) {
        setScanError(true);
        return;
      }
      const data = await res.json();
      setNetworks((data?.networks || []).map(shapeNetwork));
      setScanError(data?.available === false);
      setHasScannedOnce(true);
    } catch {
      setScanError(true);
    } finally {
      if (aliveRef.current) setScanning(false);
    }
  }, []);

  // Poll status every 3s so the step flips to "connected" the moment wpa_cli
  // hands the interface an address, without the user having to hit refresh.
  useEffect(() => {
    aliveRef.current = true;
    fetchStatus();
    fetchScan();
    statusTimer.current = setInterval(fetchStatus, 3000);
    scanTimer.current = setInterval(fetchScan, 8000);
    return () => {
      aliveRef.current = false;
      if (statusTimer.current) clearInterval(statusTimer.current);
      if (scanTimer.current) clearInterval(scanTimer.current);
    };
  }, [fetchStatus, fetchScan]);

  const handleConnect = useCallback(async () => {
    if (!selected) {
      setError("Pick your home network first.");
      return;
    }
    setConnecting(true);
    setError("");
    try {
      const res = await api("/setup/wifi/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssid: selected, passphrase: password }),
        allowNonOk: true,
      });
      if (!res.ok) {
        let message = "That password didn't work. Check the sticker on your internet box and try again.";
        try {
          const body = await res.json();
          if (typeof body?.error === "string" && body.error) message = body.error;
          else if (typeof body?.error?.message === "string") message = body.error.message;
        } catch { /* use the default */ }
        setError(message);
        return;
      }
      const data = await res.json();
      if (data?.connected) {
        setPassword("");
        setSelected("");
        onConnected();
      } else {
        // Connected to the network but not yet carrying an address — the
        // status poll will pick it up and reveal the continue button.
        onConnected();
      }
    } catch {
      setError("Couldn't reach the server while connecting. Please try again.");
    } finally {
      setConnecting(false);
    }
  }, [selected, password, onConnected]);

  return (
    <div className="flex flex-col items-center text-center py-2" data-slot="setup-wifi-step">
      <Wifi size={40} className="text-accent mx-auto mb-4" />

      <h1 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3">
        Connect to Wi-Fi
      </h1>

      <p className="text-primary/68 text-sm leading-relaxed max-w-md mb-8">
        {ethernet
          ? "You're connected by cable. Wi-Fi is optional — it lets you move LibreServ anywhere in the house."
          : "LibreServ can't reach the internet yet. Connect it to your home Wi-Fi to continue."}
      </p>

      {/* Connection state — one glance tells the user where they stand */}
      <div className="flex flex-wrap items-center justify-center gap-2 w-full max-w-sm mb-6">
        <Pill variant={ethernet ? "success" : "default"}>
          <Cable size={12} />
          {ethernet ? "Cable connected" : "No cable"}
        </Pill>
        {connected ? (
          <Pill variant="success">
            <Check size={12} />
            Connected to {status?.ssid || "Wi-Fi"}
          </Pill>
        ) : (
          <Pill variant="default">
            <Wifi size={12} />
            Wi-Fi {scanning ? "scanning…" : "not connected"}
          </Pill>
        )}
      </div>

      {/* Network list */}
      <div className="w-full max-w-sm space-y-2 mb-6 text-left">
        {scanning && !hasScannedOnce && (
          <div className="space-y-2" aria-label="Scanning for networks">
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className="h-12 rounded-large-element bg-primary/10 animate-pulse"
                style={{ animationDelay: `${i * 120}ms` }}
              />
            ))}
          </div>
        )}

        {!scanning && networks.length === 0 && !scanError && (
          <p className="text-sm text-primary/50 text-center py-4">
            No networks nearby. Move LibreServ closer to your internet box and refresh.
          </p>
        )}

        {scanError && (
          <div className="flex items-start gap-2.5 p-3.5 rounded-large-element border border-accent/25 bg-accent/10 text-left">
            <AlertCircle size={15} className="text-accent shrink-0 mt-0.5" />
            <p className="text-xs text-primary/75 leading-relaxed">
              No Wi-Fi adapter was found. If your device has one, plug it in and try again — otherwise keep the cable plugged in.
            </p>
          </div>
        )}

        {!scanError && networks.map((net) => {
          const isSelected = selected === net.ssid;
          return (
            <button
              key={net.ssid}
              type="button"
              onClick={() => { setSelected(net.ssid); setError(""); }}
              className={cn(
                "w-full flex items-center gap-3 p-3.5 rounded-large-element border text-left",
                "motion-safe:transition-all motion-safe:duration-200",
                isSelected
                  ? "border-accent bg-primary/10"
                  : "border-primary/15 hover:border-primary/35"
              )}
            >
              <Wifi size={16} className={cn("shrink-0", isSelected ? "text-primary" : "text-primary/50")} />
              <span className="flex-1 min-w-0 truncate text-sm text-primary font-mono">{net.ssid}</span>
              <span className="flex items-center gap-1.5 text-[11px] text-primary/45 shrink-0">
                {net.encrypted && <Lock size={11} className="text-primary/50" />}
                {signalLabel(net.signal)}
              </span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => { setScanError(false); fetchScan(); }}
          className="flex items-center gap-1.5 text-xs text-accent hover:text-primary motion-safe:transition-colors"
        >
          <RefreshCw size={12} className={scanning ? "animate-spin" : ""} />
          Scan again
        </button>
      </div>

      {/* Password + connect */}
      {selected && !connected && (
        <div className="w-full max-w-sm space-y-3 mb-6 text-left">
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(""); }}
              placeholder="Wi-Fi password"
              autoComplete="off"
              disabled={connecting}
              className={cn(
                "w-full pl-4 pr-11 py-3 rounded-pill font-mono text-sm",
                "bg-primary text-secondary border-2 border-accent/30",
                "focus:border-accent focus:outline-none",
                "motion-safe:transition-colors placeholder:text-secondary/40"
              )}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-secondary/50 hover:text-secondary motion-safe:transition-colors"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="text-xs text-accent">
            That password is the one on the sticker of your internet box. We never show or store it in plain sight.
          </p>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-sm text-error mb-5">
          <AlertCircle size={14} className="shrink-0" />
          {error}
        </p>
      )}

      {connected ? (
        <Button variant="primary" fullWidth onClick={onConnected} className="group py-4 font-mono animate-in fade-in slide-in-from-bottom-2 duration-300">
          Continue
        </Button>
      ) : (
        <Button
          variant="primary"
          fullWidth
          onClick={handleConnect}
          loading={connecting}
          disabled={scanError || !selected}
          className="py-4 font-mono"
        >
          {connecting ? "Connecting…" : available ? `Connect to ${selected || "Wi-Fi"}` : "Wi-Fi unavailable"}
        </Button>
      )}

      {ethernet && !connected && (
        <button
          type="button"
          onClick={onSkipWifi}
          className="flex items-center gap-1.5 text-sm text-accent hover:text-primary mt-5 motion-safe:transition-colors"
        >
          <Cable size={14} /> Use the cable instead
        </button>
      )}
    </div>
  );
}

WifiStep.propTypes = {
  onConnected: PropTypes.func.isRequired,
  onSkipWifi: PropTypes.func.isRequired,
};
