import { useState, useEffect } from "react";
import { Waypoints, Check, AlertTriangle } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Toggle from "../common/Toggle.jsx";
import Button from "../ui/Button.jsx";
import { getConnectWarning } from "./connect-utils.js";
import { updateConnectService } from "../../lib/connect-api.js";

export default function TunnelServiceModal({ open, onClose, onSaved, service, connectStatus = null, csrfToken = "", loading = false }) {
  const [useConnect, setUseConnect] = useState(
    service?.state === "connected"
  );
  const [tunnelToken, setTunnelToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setUseConnect(service?.state === "connected");
    setError(null);
     
  }, [open, service]);

  if (!open) return null;

  const connectWarning = getConnectWarning("tunnel", connectStatus);

  const stateLabel =
    service?.state === "connected"
      ? "Connected"
      : service?.state === "byo"
        ? "Bring Your Own"
        : service?.state === "unavailable"
          ? "Not in Plan"
          : "Disabled";

  return (
    <ModalCard title="Tunnel" onClose={onClose} size="md" loading={loading} data-slot="tunnel-service-modal">
      {({close}) => (
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

        {useConnect && connectWarning.show ? (
          <div className="bg-primary text-secondary border-2 border-warning/20 rounded-large-element p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm text-secondary">
              <AlertTriangle size={16} className="text-warning shrink-0" />
              {connectWarning.label}
            </div>
            <p className="text-xs text-accent">
              Connect needs to be connected and your plan must support this service
              before a tunnel can be managed automatically.
            </p>
          </div>
        ) : useConnect ? (
          <div className="bg-primary/5 rounded-large-element p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm text-primary">
              <Check size={16} className="text-accent" />
              Tunnel handled by LibreServ Connect
            </div>
            <p className="text-xs text-accent">
              Data transfer is unlimited on all plans.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-accent">
              Bring your own tunnel. We currently support Cloudflare Tunnel.
            </p>
            <div>
              <label className="block text-xs text-accent font-medium mb-1.5 px-4">Tunnel Token</label>
              <input
                type="password"
                value={tunnelToken}
                onChange={(e) => setTunnelToken(e.target.value)}
                placeholder="Cloudflare Tunnel token"
                className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
              />
            </div>
          </div>
        )}

        {error && (
          <div className="bg-error/10 text-error rounded-large-element p-3 text-sm font-mono">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await updateConnectService("tunnel", useConnect ? "connected" : "byo", csrfToken);
              if (onSaved) await onSaved();
              close();
            } catch (e) {
              const msg = e?.message || "Something went wrong while saving. Please try again.";
              setError(msg);
              console.error("Failed to save tunnel config:", e);
            } finally {
              setSaving(false);
            }
          }} disabled={saving} loading={saving}>
            Save
          </Button>
        </div>
      </div>
      )}
    </ModalCard>
  );
}
