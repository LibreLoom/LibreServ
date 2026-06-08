import { useState } from "react";
import { Sparkles, Check, AlertTriangle } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Toggle from "../common/Toggle.jsx";
import Button from "../ui/Button.jsx";
import { getConnectWarning } from "./connect-utils.js";
import { updateConnectService } from "../../lib/connect-api.js";

export default function AIServiceModal({ open, onClose, service, connectStatus = null, csrfToken = "" }) {
  const [useConnect, setUseConnect] = useState(
    service?.state === "connected"
  );
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const connectWarning = getConnectWarning("ai", connectStatus);

  const stateLabel =
    service?.state === "connected"
      ? "Connected"
      : service?.state === "byo"
        ? "Bring Your Own"
        : "Disabled";

  return (
    <ModalCard title="AI Assistant" onClose={onClose} size="md">
      {({close}) => (
      <div className="p-5 space-y-5">
        <div className="flex items-start gap-3 pb-4 border-b border-primary/10">
          <div className="p-2 rounded-full bg-primary/10">
            <Sparkles size={18} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-primary">
              Status: <span className="font-medium">{stateLabel}</span>
            </p>
            <p className="text-sm text-accent mt-1.5">
              An AI assistant can help manage and diagnose your server — check logs,
              restart services, run diagnostics, and guide you through fixes.
            </p>
          </div>
        </div>

        <Toggle
          checked={useConnect}
          onChange={setUseConnect}
          label="Use LibreServ Connect"
          description={
            useConnect
              ? "Use Connect's AI model routing."
              : "Bring your own API key for a model provider."
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
              before the AI assistant can be used through Connect.
            </p>
          </div>
        ) : useConnect ? (
          <div className="space-y-3">
            <div className="bg-primary/5 rounded-large-element p-4 space-y-2">
              <div className="flex items-center gap-2 text-sm text-primary">
                <Check size={16} className="text-accent" />
                AI handled by LibreServ Connect
              </div>
              <p className="text-xs text-accent">
                50 messages/month on Free. One and PAYG plans have unlimited access.
              </p>
            </div>
            <div className="bg-primary border-2 border-warning/20 rounded-large-element p-3 flex items-start gap-2">
              <AlertTriangle size={16} className="text-warning shrink-0 mt-0.5" />
              <p className="text-xs text-accent">
                The free model router doesn't guarantee data privacy. Avoid sending
                sensitive information. Upgrade to paid or bring your own key for
                private AI access.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-accent">
              Use your own AI provider. Your API key stays between you and your
              chosen provider.
            </p>
            <div>
              <label className="block text-xs text-accent font-medium mb-1.5 px-4">API Key</label>
              <input
                type="password"
                placeholder="sk-..."
                className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-accent font-medium mb-1.5 px-4">Base URL</label>
              <input
                type="text"
                placeholder="https://api.openai.com/v1"
                className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-accent font-medium mb-1.5 px-4">Default Model</label>
              <input
                type="text"
                placeholder="gpt-4o"
                className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
              />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="accent" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={async () => {
            setSaving(true);
            try {
              await updateConnectService("ai", useConnect ? "connected" : "byo", csrfToken);
              close();
            } catch (e) {
              console.error("Failed to save AI service config:", e);
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
