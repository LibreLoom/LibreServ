import { useState } from "react";
import { Waypoints, Check } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Toggle from "../common/Toggle.jsx";
import Button from "../ui/Button.jsx";

export default function TunnelServiceModal({ open, onClose, service }) {
  const [useConnect, setUseConnect] = useState(
    service?.state === "connected"
  );

  if (!open) return null;

  const stateLabel =
    service?.state === "connected"
      ? "Connected"
      : service?.state === "byo"
        ? "Bring Your Own"
        : "Disabled";

  return (
    <ModalCard title="Tunnel" onClose={onClose} size="md">
      <div className="p-5 space-y-5">
        <div className="flex items-start gap-3 pb-4 border-b border-primary/10">
          <div className="p-2 rounded-full bg-primary/10">
            <Waypoints size={18} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-primary">
              Status: <span className="font-medium">{stateLabel}</span>
            </p>
            <p className="text-sm text-accent mt-1.5">
              A tunnel provides access to your server when it's behind a firewall,
              CGNAT, or doesn't have a public IP.
            </p>
          </div>
        </div>

        <Toggle
          checked={useConnect}
          onChange={setUseConnect}
          label="Use LibreServ Connect"
          description={
            useConnect
              ? "Connect manages a tunnel endpoint for your server."
              : "Use your own tunnel provider."
          }
        />

        {useConnect ? (
          <div className="bg-primary/5 rounded-large-element p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm text-primary">
              <Check size={16} className="text-accent" />
              Tunnel handled by LibreServ Connect
            </div>
            <p className="text-xs text-accent">
              Free: 1 Mbps, 1 GB/month. One and PAYG: full speed, unlimited transfer.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-accent">
              Bring your own tunnel. We currently support Cloudflare Tunnel.
            </p>
            <div>
              <label className="block text-xs text-accent font-medium mb-1.5">Tunnel Token</label>
              <input
                type="password"
                placeholder="Cloudflare Tunnel token"
                className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
              />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="accent" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onClose}>
            Save
          </Button>
        </div>
      </div>
    </ModalCard>
  );
}
