import { useState } from "react";
import { ShieldCheck, Check } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Toggle from "../common/Toggle.jsx";
import Button from "../ui/Button.jsx";

export default function SSLServiceModal({ open, onClose, service }) {
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
    <ModalCard title="SSL Certificates" onClose={onClose} size="md">
      <div className="p-5 space-y-5">
        <div className="flex items-start gap-3 pb-4 border-b border-primary/10">
          <div className="p-2 rounded-full bg-primary/10">
            <ShieldCheck size={18} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-primary">
              Status: <span className="font-medium">{stateLabel}</span>
            </p>
            <p className="text-sm text-accent mt-1.5">
              SSL certificates let browsers connect securely to your apps. They're
              required for modern browsers to trust your site.
            </p>
          </div>
        </div>

        <Toggle
          checked={useConnect}
          onChange={setUseConnect}
          label="Use LibreServ Connect"
          description={
            useConnect
              ? "SSL certificates are managed automatically through Connect's DNS."
              : "Configure certificates manually with Let's Encrypt."
          }
        />

        {useConnect ? (
          <div className="bg-primary/5 rounded-large-element p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm text-primary">
              <Check size={16} className="text-accent" />
              SSL handled by LibreServ Connect
            </div>
            <p className="text-xs text-accent">
              Certificates are issued and renewed automatically. No configuration needed.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-accent">
              Use your own certificate authority. We support external ACME providers
              like Let's Encrypt with DNS challenge.
            </p>
            <div>
              <label className="block text-xs text-accent font-medium mb-1.5">ACME DNS Provider</label>
              <select className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm">
                <option value="cloudflare">Cloudflare</option>
                <option value="route53">AWS Route53</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-accent font-medium mb-1.5">Contact Email</label>
              <input
                type="email"
                placeholder="admin@yourdomain.com"
                className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
              />
              <p className="text-xs text-accent mt-1.5">
                Used by Let's Encrypt to send expiration notices.
              </p>
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
