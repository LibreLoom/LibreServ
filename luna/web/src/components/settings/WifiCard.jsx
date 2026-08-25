import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Eye, EyeOff, Wifi } from "lucide-react";
import Card from "../cards/Card";
import ModalCard from "../cards/ModalCard";
import Button from "../ui/Button";
import Pill from "../common/Pill";
import { TermHint } from "../ui/Tooltip";
import { getJson, postJson, apiErrorMessage } from "../../lib/api";

export default function WifiCard() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");

  const wifiStatus = useQuery({
    queryKey: ["wifi-status"],
    queryFn: () => getJson("/api/v1/network/wifi"),
    refetchInterval: 5000,
    retry: false,
  });
  const netStatus = useQuery({
    queryKey: ["network-status"],
    queryFn: () => getJson("/api/v1/network/status"),
    refetchInterval: 5000,
    retry: false,
  });
  const scan = useQuery({
    queryKey: ["wifi-scan"],
    queryFn: () => getJson("/api/v1/network/wifi/scan"),
    enabled: open,
    refetchInterval: open ? 8000 : false,
    retry: false,
  });

  const wifi = wifiStatus.data;
  const ethernet = Boolean(netStatus.data?.ethernet_connected);
  const wifiConnected = Boolean(wifi?.connected);
  const ssid = wifi?.ssid || "";
  const networks = (scan.data || []).filter((n) => n?.ssid);

  const close = useCallback(() => {
    setOpen(false);
    setSelected("");
    setPassword("");
    setShowPassword(false);
    setError("");
  }, []);

  async function connect() {
    if (!selected) {
      setError("Pick your home network first.");
      return;
    }
    setConnecting(true);
    setError("");
    try {
      await postJson("/api/v1/network/wifi/connect", { ssid: selected, password });
      queryClient.invalidateQueries({ queryKey: ["wifi-status"] });
      queryClient.invalidateQueries({ queryKey: ["network-status"] });
      close();
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't join that network. Check the password on your router or modem."));
    } finally {
      setConnecting(false);
    }
  }

  async function forget() {
    setError("");
    try {
      await postJson("/api/v1/network/wifi/forget", {});
      queryClient.invalidateQueries({ queryKey: ["wifi-status"] });
    } catch (err) {
      setError(apiErrorMessage(err, "Luna couldn't forget that network."));
    }
  }

  return (
    <>
      <Card icon={Wifi} title="Home network">
        <p className="text-primary text-sm">
          Phones and computers reach Luna on this network. A cable is the most
          reliable. Wi-Fi is fine if Luna sits away from your{" "}
          <TermHint content="The box that brings internet into the house. Often labeled WAN, Internet, or LAN on the back.">
            router
          </TermHint>
          {" "}or modem.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-primary">
          <li className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <Cable size={16} aria-hidden="true" />
              Cable
            </span>
            <Pill variant={ethernet ? "success" : "muted"}>
              {ethernet ? "Plugged in" : "Not plugged in"}
            </Pill>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <Wifi size={16} aria-hidden="true" />
              Wi-Fi
            </span>
            <Pill variant={wifiConnected ? "success" : "muted"}>
              {wifiConnected ? `On ${ssid || "Wi-Fi"}` : "Not connected"}
            </Pill>
          </li>
        </ul>
        {error && !open && <p className="text-error text-sm mt-3">{error}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setOpen(true)}>
            {wifiConnected ? "Change Wi-Fi" : "Join Wi-Fi"}
          </Button>
          {wifiConnected && (
            <Button variant="outline" onClick={forget}>
              Forget this Wi-Fi
            </Button>
          )}
        </div>
      </Card>

      {open && (
        <ModalCard title="Connect to Wi-Fi" onClose={close}>
          <p className="text-primary text-sm mb-3">
            Pick your home network. The password is usually on a sticker on your router or modem.
          </p>
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {networks.map((net) => (
              <button
                key={net.ssid}
                type="button"
                className={`w-full text-left rounded-large-element px-4 py-3 text-sm ring-2 ${
                  selected === net.ssid
                    ? "bg-primary text-secondary ring-primary"
                    : "bg-secondary text-primary ring-accent"
                }`}
                onClick={() => setSelected(net.ssid)}
              >
                {net.ssid}
              </button>
            ))}
            {scan.isFetching && networks.length === 0 && (
              <p className="text-primary text-sm">Looking for networks…</p>
            )}
            {!scan.isFetching && networks.length === 0 && (
              <p className="text-primary text-sm">
                No networks yet. Move Luna closer to the router or modem and try again.
              </p>
            )}
          </div>
          {selected && (
            <div className="relative mt-3">
              <input
                type={showPassword ? "text" : "password"}
                className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 pr-12 text-sm"
                placeholder="Wi-Fi password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="absolute right-4 top-1/2 -translate-y-1/2 text-secondary"
                aria-label={showPassword ? "Hide password" : "Show password"}
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          )}
          {error && <p className="text-error text-sm mt-3">{error}</p>}
          <div className="mt-4 flex gap-3">
            <Button variant="primary" loading={connecting} disabled={!selected} onClick={connect}>
              {selected ? `Connect to ${selected}` : "Pick a network"}
            </Button>
            <Button variant="outline" onClick={close}>Not now</Button>
          </div>
        </ModalCard>
      )}
    </>
  );
}
