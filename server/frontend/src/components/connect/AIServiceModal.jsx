import { useState, useEffect } from "react";
import { Sparkles, Check, AlertTriangle } from "lucide-react";
import ModalCard from "../cards/ModalCard.jsx";
import Toggle from "../common/Toggle.jsx";
import Dropdown from "../common/Dropdown.jsx";
import Button from "../ui/Button.jsx";
import { getConnectWarning } from "./connect-utils.js";
import { updateConnectService } from "../../lib/connect-api.js";
import { updateAISettings } from "../../lib/settings-api.js";

const FORMAT_OPTIONS = [
  { value: "openai", label: "OpenAI (Chat Completions)" },
  { value: "anthropic", label: "Anthropic (Messages)" },
];

export default function AIServiceModal({ open, onClose, onSaved, service, connectStatus = null, aiSettings = null, planLimits = null, csrfToken = "", loading = false }) {
  const rawSettings = aiSettings || {};
  const [useConnect, setUseConnect] = useState(service?.state === "connected");
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState(rawSettings.user_base_url || "");
  const [apiFormat, setApiFormat] = useState(rawSettings.user_api_format || "openai");
  const [mainModel, setMainModel] = useState(rawSettings.main_model || "");
  const [reviewModel, setReviewModel] = useState(rawSettings.review_model || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const modelOptions = (rawSettings.available_models || []).map((m) => ({
    value: m.id,
    label: m.name || m.id,
  }));

  useEffect(() => {
    if (!open) return;
    setUseConnect(service?.state === "connected");
    setApiKey("");
    setBaseURL(rawSettings.user_base_url || "");
    setApiFormat(rawSettings.user_api_format || "openai");
    setMainModel(rawSettings.main_model || "");
    setReviewModel(rawSettings.review_model || "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, service, aiSettings]);

  if (!open) return null;

  const connectWarning = getConnectWarning("ai", connectStatus);

  const stateLabel =
    service?.state === "connected"
      ? "Connected"
      : service?.state === "byo"
        ? "Bring Your Own"
        : service?.state === "unavailable"
          ? "Not in Plan"
          : "Disabled";

  async function handleSave(close) {
    setSaving(true);
    setError(null);
    try {
      await updateConnectService("ai", useConnect ? "connected" : "byo", csrfToken);

      /** @type {Record<string, any>} */
      const aiUpdates = { byok_enabled: !useConnect };
      if (!useConnect) {
        aiUpdates.main_model = mainModel || undefined;
        aiUpdates.review_model = reviewModel || undefined;
        aiUpdates.user_api_key = apiKey || undefined;
        aiUpdates.user_base_url = baseURL || undefined;
        aiUpdates.user_api_format = apiFormat;
      }
      await updateAISettings(aiUpdates, csrfToken);

      if (onSaved) await onSaved();
      close();
    } catch (e) {
      const msg = e?.message || "Something went wrong while saving. Please try again.";
      setError(msg);
      console.error("Failed to save AI service config:", e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalCard title="AI Assistant" onClose={onClose} size="md" loading={loading} data-slot="ai-service-modal">
      {({ close }) => (
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
            <div className="bg-primary text-secondary border-2 border-warning/20 rounded-large-element p-4 space-y-2">
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
                  {planLimits?.ai_messages_per_day > 0
                    ? `${planLimits.ai_messages_per_day.toLocaleString()} messages/day included on your ${connectStatus?.plan?.name || "plan"}.`
                    : "No message limit — usage is covered by your included credit."}
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
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
                />
                {rawSettings.user_key_configured && (
                  <p className="text-xs text-accent mt-1 px-4">
                    A key is already saved. Enter a new one to replace it, or leave blank to keep it.
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs text-accent font-medium mb-1.5 px-4">Base URL</label>
                <input
                  type="text"
                  placeholder="https://api.openai.com/v1"
                  value={baseURL}
                  onChange={(e) => setBaseURL(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-accent font-medium mb-1.5 px-4">Agent Model</label>
                {modelOptions.length > 0 ? (
                  <Dropdown
                    value={mainModel}
                    onChange={setMainModel}
                    fullWidth
                    bg="primary"
                    placeholder="Select a model"
                    options={modelOptions}
                  />
                ) : (
                  <input
                    type="text"
                    placeholder="deepseek/deepseek-v4-pro"
                    value={mainModel}
                    onChange={(e) => setMainModel(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
                  />
                )}
                <p className="text-xs text-accent mt-1 px-4">
                  The model that handles your conversations.
                </p>
              </div>
              <div>
                <label className="block text-xs text-accent font-medium mb-1.5 px-4">Review Model</label>
                {modelOptions.length > 0 ? (
                  <Dropdown
                    value={reviewModel}
                    onChange={setReviewModel}
                    fullWidth
                    bg="primary"
                    placeholder="Select a model"
                    options={modelOptions}
                  />
                ) : (
                  <input
                    type="text"
                    placeholder="deepseek/deepseek-v4-flash"
                    value={reviewModel}
                    onChange={(e) => setReviewModel(e.target.value)}
                    className="w-full px-4 py-2.5 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors text-sm"
                  />
                )}
                <p className="text-xs text-accent mt-1 px-4">
                  The model that reviews tool calls for safety before they run.
                </p>
              </div>
              <div>
                <label className="block text-xs text-accent font-medium mb-1.5 px-4">API Format</label>
                <Dropdown
                  value={apiFormat}
                  onChange={setApiFormat}
                  fullWidth
                  bg="primary"
                  options={FORMAT_OPTIONS}
                />
                <p className="text-xs text-accent mt-1 px-4">
                  Choose the format your provider uses. Most providers (OpenAI, Makora, Together, Groq) use OpenAI. Umans uses Anthropic.
                </p>
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
            <Button onClick={() => handleSave(close)} disabled={saving} loading={saving}>
              Save
            </Button>
          </div>
        </div>
      )}
    </ModalCard>
  );
}
