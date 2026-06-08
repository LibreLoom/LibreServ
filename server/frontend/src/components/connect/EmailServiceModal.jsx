import { useState } from "react";
import { Mail, Check, AlertTriangle } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Toggle from "../common/Toggle.jsx";
import Button from "../ui/Button.jsx";
import { getConnectWarning } from "./connect-utils.js";
import { updateConnectService } from "../../lib/connect-api.js";

export default function EmailServiceModal({ open, onClose, service, connectStatus = null, csrfToken = "" }) {
  const [useConnect, setUseConnect] = useState(
    service?.state === "connected"
  );
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    host: "",
    port: "587",
    username: "",
    password: "",
    from: "",
    useTls: true,
  });

  if (!open) return null;

  const connectWarning = getConnectWarning("smtp", connectStatus);

  const stateLabel =
    service?.state === "connected"
      ? "Connected"
      : service?.state === "byo"
        ? "Bring Your Own"
        : "Disabled";

  return (
    <ModalCard title="Email / SMTP" onClose={onClose} size="md">
      {({close}) => (
      <div className="p-5 space-y-5">
        <div className="flex items-start gap-3 pb-4 border-b border-primary/10">
          <div className="p-2 rounded-full bg-primary/10">
            <Mail size={18} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-primary">
              Status: <span className="font-medium">{stateLabel}</span>
            </p>
            <p className="text-sm text-accent mt-1.5">
              Your server needs email to send notifications, password resets, and
              alerts. Email providers invest in trust so their mail doesn't get
              flagged as spam — your server sends through them.
            </p>
          </div>
        </div>

        <Toggle
          checked={useConnect}
          onChange={setUseConnect}
          label="Use LibreServ Connect"
          description={
            useConnect
              ? "Connect handles all email delivery. No configuration needed."
              : "Configure your own email provider."
          }
        />

        {useConnect && connectWarning.show ? (
          <div className="bg-primary border-2 border-warning/20 rounded-large-element p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm text-secondary">
              <AlertTriangle size={16} className="text-warning shrink-0" />
              {connectWarning.label}
            </div>
            <p className="text-xs text-accent">
              Connect needs to be connected and your plan must support this service
              before email delivery can be handled automatically.
            </p>
          </div>
        ) : useConnect ? (
          <div className="bg-primary/5 rounded-large-element p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm text-primary">
              <Check size={16} className="text-accent" />
              Email handled by LibreServ Connect
            </div>
            <p className="text-xs text-accent">
              Emails are sent through Connect's trusted relay. See
              connect.serv.libreloom.org for your plan's limits.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-accent">
              Enter your SMTP provider details. Choose Proton, Resend, Postmark, or
              any SMTP-compatible service.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-xs text-accent font-medium mb-1.5 px-4">SMTP Host</label>
                <input
                  type="text"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder="smtp.example.com"
                  className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
                />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-xs text-accent font-medium mb-1.5 px-4">Port</label>
                <input
                  type="text"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                  placeholder="587"
                  className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
                />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-xs text-accent font-medium mb-1.5 px-4">Username</label>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="postmaster@example.com"
                  className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
                />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-xs text-accent font-medium mb-1.5 px-4">Password</label>
                <input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  placeholder="SMTP password or API key"
                  className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-accent font-medium mb-1.5 px-4">From Address</label>
                <input
                  type="email"
                  value={form.from}
                  onChange={(e) => setForm({ ...form, from: e.target.value })}
                  placeholder="noreply@yourdomain.com"
                  className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
                />
              </div>
            </div>
            <Toggle
              checked={form.useTls}
              onChange={(v) => setForm({ ...form, useTls: v })}
              label="Use TLS"
              description="Encrypts the connection to your email provider."
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="accent" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={async () => {
            setSaving(true);
            try {
              if (useConnect) {
                await updateConnectService("smtp", "connected", csrfToken);
              } else {
                await updateConnectService("smtp", "byo", csrfToken);
              }
              close();
            } catch (e) {
              console.error("Failed to save email service config:", e);
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
