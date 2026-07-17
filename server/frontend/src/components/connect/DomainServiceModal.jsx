import { useState } from "react";
import { Globe, Check, AlertTriangle } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Toggle from "../common/Toggle.jsx";
import Dropdown from "../common/Dropdown.jsx";
import Button from "../ui/Button.jsx";
import { getConnectWarning } from "./connect-utils.js";
import { updateConnectService } from "../../lib/connect-api.js";

const DNS_PROVIDERS = [
  { value: "cloudflare", label: "Cloudflare" },
  { value: "route53", label: "AWS Route53" },
  { value: "digitalocean", label: "DigitalOcean" },
  { value: "gandi", label: "Gandi" },
  { value: "namecheap", label: "Namecheap" },
];

export default function DomainServiceModal({ open, onClose, service, connectStatus = null, csrfToken = "" }) {
  const [useConnect, setUseConnect] = useState(
    service?.state === "connected"
  );
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    domain: "",
    provider: "cloudflare",
    apiToken: "",
    email: "",
  });

  if (!open) return null;

  const connectWarning = getConnectWarning("domain", connectStatus);

  const stateLabel =
    service?.state === "connected"
      ? "Connected"
      : service?.state === "byo"
        ? "Bring Your Own"
        : "Disabled";

  return (
    <ModalCard title="Domain & DNS" onClose={onClose} size="md" data-slot="domain-service-modal">
      {({close}) => (
      <div className="p-5 space-y-5">
        <div className="flex items-start gap-3 pb-4 border-b border-primary/10">
          <div className="p-2 rounded-full bg-primary/10">
            <Globe size={18} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-primary">
              Status: <span className="font-medium">{stateLabel}</span>
            </p>
            <p className="text-sm text-accent mt-1.5">
              A domain name lets you reach your apps at addresses like
              nextcloud.yourdomain.com instead of a numbered IP address.
            </p>
          </div>
        </div>

        <Toggle
          checked={useConnect}
          onChange={setUseConnect}
          label="Use LibreServ Connect"
          description={
            useConnect
              ? "Connect gives you yourchoice.servers.libreloom.org with automatic SSL."
              : "Use your own domain with a DNS provider."
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
              before your domain can be managed automatically.
            </p>
          </div>
        ) : useConnect ? (
          <div className="bg-primary/5 rounded-large-element p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm text-primary">
              <Check size={16} className="text-accent" />
              Domain handled by LibreServ Connect
            </div>
            <p className="text-xs text-accent">
              Your server will be reachable at your choice of subdomain. SSL
              certificates are managed automatically.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-accent">
              Connect your own domain. We'll help set up DNS records.
            </p>
            <div>
              <label className="block text-xs text-accent font-medium mb-1.5 px-4">Your Domain</label>
              <input
                type="text"
                value={form.domain}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
                placeholder="yourdomain.com"
                className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-accent font-medium mb-1.5 px-4">DNS Provider</label>
              <Dropdown
                options={DNS_PROVIDERS}
                value={form.provider}
                onChange={(v) => setForm({ ...form, provider: v })}
                placeholder="Select a DNS provider"
                fullWidth
                surface="primary"
              />
            </div>
            <div>
              <label className="block text-xs text-accent font-medium mb-1.5 px-4">API Token</label>
              <input
                type="password"
                value={form.apiToken}
                onChange={(e) => setForm({ ...form, apiToken: e.target.value })}
                placeholder="DNS provider API token"
                className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
              />
              <p className="text-xs text-accent mt-1.5">
                Your API token is on cloudflare.com → Profile → API Tokens → Create Token.
              </p>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={async () => {
            setSaving(true);
            try {
              await updateConnectService("domain", useConnect ? "connected" : "byo", csrfToken);
              close();
            } catch (e) {
              console.error("Failed to save domain config:", e);
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
