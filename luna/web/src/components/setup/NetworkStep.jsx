import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PropTypes from "prop-types";
import { AlertCircle, ArrowRight, Cable, Check, Eye, EyeOff, Lock, RefreshCw, Router, Wifi, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getJson, postJson } from "../../lib/api";
import Button from "../ui/Button";
import Pill from "../common/Pill";
import ModalCard from "../cards/ModalCard";

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
 * NetworkStep — the "Get online" step of the wizard.
 *
 * MIRROR COMPONENT — keep in lockstep with
 * server/frontend/src/components/setup/NetworkStep.jsx. The two files differ
 * only in how they reach their backends (Luna uses react-query against
 * /api/v1/network/* — Wi-Fi state on /network/wifi, cable state on
 * /network/status, a raw network array from /network/wifi/scan — while
 * LibreServ polls /setup/wifi/* with plain api() calls). Everything the user
 * sees — layout, copy (with the product name), behavior — is identical.
 * Change one, change the other in the same commit.
 *
 * Rendered inside SetupPage's card shell (bg-secondary, text-primary), so all
 * text uses the primary/ink ramp and the single accent tone — no extra colors.
 *
 * This step is about getting the device ONLINE, not Wi-Fi specifically:
 *   - The connection board shows both paths and their state at a glance:
 *     Cable ("Plugged in" / "Not plugged in") and Wi-Fi ("Connected to X" /
 *     "Not connected" / "Not available").
 *   - Continue appears as soon as EITHER path is up; both can be used
 *     together. There is no "skip" — the device must be online to proceed.
 *   - The board polls every 3s, so a user who plugs a cable in gets the
 *     Continue button without touching the Wi-Fi list.
 *   - Wi-Fi join (required while offline, optional while online by cable)
 *     opens in a ModalCard — never inline on the step.
 */

/** One row of the connection board: a path (cable or Wi-Fi) and its state. */
function BoardRow({ icon, label, ok, okText, offText }) {
  const Icon = icon;
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 p-3.5 rounded-large-element border",
        "motion-safe:transition-colors motion-safe:duration-300",
        ok ? "bg-success/20 border-success/30" : "bg-primary/10 border-primary/15"
      )}
    >
      <span className="flex items-center gap-2.5 min-w-0">
        <Icon
          size={16}
          className={cn("shrink-0 motion-safe:transition-colors motion-safe:duration-300", ok ? "text-success" : "text-primary/40")}
        />
        <span className="font-mono text-sm text-primary">{label}</span>
      </span>
      <Pill variant={ok ? "success" : "muted"} className="shrink-0">
        {ok ? <Check size={12} /> : <X size={12} />}
        <span className="max-w-44 truncate">{ok ? okText : offText}</span>
      </Pill>
    </div>
  );
}
BoardRow.propTypes = {
  icon: PropTypes.elementType.isRequired,
  label: PropTypes.string.isRequired,
  ok: PropTypes.bool.isRequired,
  okText: PropTypes.string.isRequired,
  offText: PropTypes.string.isRequired,
};

export default function NetworkStep({ name, onContinue }) {
  const [wifiModalOpen, setWifiModalOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  // Poll status every 3s so the board flips the moment a cable is plugged in
  // or wpa_cli hands the interface an address — no refresh needed. The scan
  // repeats every 8s so new networks appear on their own.
  const wifiStatus = useQuery({
    queryKey: ["wifi-status"],
    queryFn: () => getJson("/api/v1/network/wifi"),
    refetchInterval: 3000,
    retry: false,
  });
  const netStatus = useQuery({
    queryKey: ["network-status"],
    queryFn: () => getJson("/api/v1/network/status"),
    refetchInterval: 3000,
    retry: false,
  });
  const wifi = wifiStatus.data;
  // Luna reports the adapter state (/network/wifi) and the cable state
  // (/network/status) on separate endpoints — merge into one view.
  const ethernet = Boolean(netStatus.data?.ethernet_connected);
  const wifiConnected = Boolean(wifi?.connected);
  // Until the first status arrives, assume the device has a radio so the
  // Connect button renders optimistically instead of flashing the cable instruction.
  const wifiAvailable = wifi ? wifi.available !== false : true;
  const online = ethernet || wifiConnected;

  const scan = useQuery({
    queryKey: ["wifi-scan"],
    queryFn: () => getJson("/api/v1/network/wifi/scan"),
    refetchInterval: 8000,
    retry: false,
    // No point polling a scan on a device without a radio.
    enabled: wifi === undefined || wifi.available !== false,
  });

  const networks = (scan.data || []).map(shapeNetwork);
  const hasScannedOnce = scan.data !== undefined || scan.isError;
  const scanning = scan.isFetching && !hasScannedOnce;
  const scanError = scan.isError;

  const closeWifiModal = useCallback(() => {
    setWifiModalOpen(false);
    setSelected("");
    setPassword("");
    setShowPassword(false);
    setError("");
  }, []);

  // If Wi-Fi comes up while the modal is open (connect success or cable race),
  // dismiss it so the board + Continue are what the user sees next.
  useEffect(() => {
    if (wifiConnected && wifiModalOpen) closeWifiModal();
  }, [wifiConnected, wifiModalOpen, closeWifiModal]);

  const handleConnect = useCallback(async () => {
    if (!selected) {
      setError("Pick your home network first.");
      return;
    }
    setConnecting(true);
    setError("");
    try {
      await postJson("/api/v1/network/wifi/connect", { ssid: selected, password });
      setPassword("");
      setSelected("");
      // The response doesn't carry the board's state — refetch it so the
      // board flips immediately; the 3s poll keeps it honest afterwards.
      // The step does NOT advance on its own: the user confirms with
      // Continue. The modal closes via the wifiConnected effect above.
      wifiStatus.refetch();
    } catch (err) {
      // The backend already writes these in plain language ("That password
      // didn't work. Check the sticker on your internet box and try again.").
      setError(err?.message || "Couldn't reach the server while connecting. Please try again.");
    } finally {
      setConnecting(false);
    }
  }, [selected, password, wifiStatus]);

  return (
    <div className="flex flex-col items-center text-center py-2" data-slot="setup-network-step">
      <Router size={40} className="text-accent mx-auto mb-4" />

      <h1 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3">
        Get online
      </h1>

      <p className="text-primary/68 text-sm leading-relaxed max-w-md mb-8">
        {online
          ? `You're connected — ${name} can reach your internet now.`
          : wifiAvailable
            ? `${name} needs a way to reach your internet. Plug a cable into the back, or connect to your home Wi-Fi — either one works.`
            : `This device can't use Wi-Fi, so a cable is the only way to get ${name} online.`}
      </p>

      {/* Connection board — one glance shows every path and its state */}
      <div className="w-full max-w-sm space-y-2 mb-8" data-slot="network-board">
        <BoardRow icon={Cable} label="Cable" ok={ethernet} okText="Plugged in" offText="Not plugged in" />
        <BoardRow
          icon={Wifi}
          label="Wi-Fi"
          ok={wifiConnected}
          okText={wifi?.ssid ? `Connected to ${wifi.ssid}` : "Connected"}
          offText={wifiAvailable ? "Not connected" : "Not available"}
        />
      </div>

      {/* Offline: open the Wi-Fi modal — or, when there's no radio, plug a cable. */}
      {!online && wifiAvailable && (
        <div className="w-full max-w-sm flex flex-col items-center space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <Button
            variant="primary"
            fullWidth
            onClick={() => setWifiModalOpen(true)}
            className="py-4 font-mono"
          >
            <Wifi size={16} />
            Connect to Wi-Fi
          </Button>
        </div>
      )}

      {!online && !wifiAvailable && (
        <div
          className="w-full max-w-sm p-4 rounded-large-element border border-accent/25 bg-accent/10 flex items-start gap-3 text-left animate-in fade-in slide-in-from-bottom-2 duration-300"
          data-slot="network-cable-only"
        >
          <Cable size={18} className="text-accent shrink-0 mt-0.5" />
          <p className="text-sm text-primary/80 leading-relaxed">
            Plug a cable into the back of {name}. This screen updates the moment it&rsquo;s connected, and you can continue right there.
          </p>
        </div>
      )}

      {/* Online: one exit (Continue), plus the optional Wi-Fi path. */}
      {online && (
        <div className="w-full max-w-sm flex flex-col items-center space-y-5 text-left animate-in fade-in slide-in-from-bottom-2 duration-300" data-slot="network-online">
          <Button
            variant="primary"
            fullWidth
            onClick={onContinue}
            className="group py-4 font-mono"
          >
            Continue
            <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
          </Button>

          {!wifiConnected && wifiAvailable && (
            <button
              type="button"
              onClick={() => setWifiModalOpen(true)}
              className="flex items-center gap-1.5 text-sm text-accent hover:text-primary motion-safe:transition-colors"
            >
              <Wifi size={14} />
              Also connect Wi-Fi (optional)
            </button>
          )}

          {wifiConnected && !ethernet && (
            <p className="text-xs text-accent">
              A cable is the most reliable connection. Plug one in any time — both can be used together.
            </p>
          )}
        </div>
      )}

      {wifiModalOpen && (
        <ModalCard
          title="Connect to Wi-Fi"
          onClose={closeWifiModal}
          footer={(
            <Button
              variant="accent"
              fullWidth
              onClick={handleConnect}
              loading={connecting}
              disabled={!selected || connecting}
              className="py-4 font-mono"
            >
              {connecting ? "Connecting…" : selected ? `Connect to ${selected}` : "Pick a network above"}
            </Button>
          )}
        >
          <div className="space-y-2 text-left" data-slot="network-wifi-picker">
            <p className="text-sm text-primary mb-3">
              Pick your home network. The password is usually on a sticker on your internet box.
            </p>

            {scanning && (
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

            {!scanning && !scanError && networks.length === 0 && (
              <p className="text-sm text-primary text-center py-4">
                No networks nearby. Move {name} closer to your internet box.
              </p>
            )}

            {!scanError &&
              networks.map((net) => {
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

            {scanError && (
              <div className="flex items-start gap-2.5 p-3.5 rounded-large-element border border-accent/25 bg-accent/10">
                <AlertCircle size={15} className="text-accent shrink-0 mt-0.5" />
                <p className="text-xs text-primary leading-relaxed">
                  We couldn&rsquo;t see any networks. Move {name} closer to your internet box, or try again.
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={() => scan.refetch()}
              className="flex items-center gap-1.5 text-xs text-accent hover:text-primary motion-safe:transition-colors"
            >
              <RefreshCw size={12} className={scanning ? "animate-spin" : ""} />
              Scan again
            </button>

            {selected && !wifiConnected && (
              <div className="space-y-3 pt-2 animate-in fade-in slide-in-from-bottom-1 duration-200">
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
              <p className="flex items-center gap-1.5 text-sm text-error" role="alert">
                <AlertCircle size={14} className="shrink-0" />
                {error}
              </p>
            )}
          </div>
        </ModalCard>
      )}
    </div>
  );
}

NetworkStep.propTypes = {
  name: PropTypes.string.isRequired,
  onContinue: PropTypes.func.isRequired,
};
