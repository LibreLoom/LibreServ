import { useState, useEffect, useCallback } from "react";
import { Cpu, Plus, Trash, Save } from "lucide-react";
import { useAuth } from "../../hooks/useAuth.jsx";
import { useToast } from "../../context/ToastContext";
import ModalCard from "../cards/ModalCard.jsx";
import Card from "../cards/Card.jsx";
import Button from "../ui/Button.jsx";
import Toggle from "../common/Toggle.jsx";
import Dropdown from "../common/Dropdown.jsx";
import { getAISettings, updateAISettings, fetchAIModels } from "../../lib/settings-api.js";

export default function AgentConfigModal({ open, onClose, onSaved }) {
  const { csrfToken } = useAuth();
  const { addToast } = useToast();
  const [settings, setSettings] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);
  const [fetchedModels, setFetchedModels] = useState([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const data = await getAISettings();
      setSettings(data?.ai_support || {});
      setAvailableModels(data?.ai_support?.available_models || []);
    } catch {
      addToast({ type: "error", message: "Could not load AI settings. Please try again later." });
    }
  }, [addToast]);

  useEffect(() => {
    if (!open) return;
    loadSettings();
  }, [open, loadSettings]);

  const fetchProviderModels = async () => {
    const baseURL = settings?.user_base_url || settings?.inference_base_url || "";
    const apiKey = settings?.user_api_key || "";
    const apiFormat = settings?.user_api_format || "openai";
    if (!baseURL || !apiKey) {
      addToast({ type: "error", message: "Enter a provider URL and API key before fetching models." });
      return;
    }
    setIsFetchingModels(true);
    try {
      const result = await fetchAIModels(baseURL, apiKey, csrfToken, apiFormat);
      const models = result?.data?.models || result?.models || [];
      setFetchedModels(models);
      addToast({ type: "success", message: `Found ${models.length} models.` });
    } catch {
      addToast({ type: "error", message: "Could not fetch models. Check your provider URL and API key." });
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateAISettings(settings, csrfToken);
      addToast({ type: "success", message: "AI settings saved." });
      onSaved?.();
      onClose();
    } catch {
      addToast({ type: "error", message: "Could not save AI settings. Please try again later." });
    } finally {
      setSaving(false);
    }
  };

  const updateField = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const addAgent = () => {
    const idx = (settings?.agents?.length || 0) + 1;
    // color-scan: ignore-next-line Agent avatar color palette (distinct hues for multi-agent visual identity)
    const colors = ["#FF6B35", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7"];
    const newAgent = {
      id: `agent-${idx}`,
      trigger: "chat",
      model: availableModels[0]?.id || "",
      max_turns: 20,
      permission_mode: "standard",
      avatar_shape: "circle",
      avatar_color: colors[idx % colors.length],
      tools: ["podman", "files", "diagnostics", "snapshots"],
    };
    setSettings((prev) => ({
      ...prev,
      agents: [...(prev?.agents || []), newAgent],
    }));
  };

  const removeAgent = (idx) => {
    setSettings((prev) => ({
      ...prev,
      agents: (prev?.agents || []).filter((_, i) => i !== idx),
    }));
  };

  const updateAgent = (idx, key, value) => {
    setSettings((prev) => {
      const agents = [...(prev?.agents || [])];
      agents[idx] = { ...agents[idx], [key]: value };
      return { ...prev, agents };
    });
  };

  if (!open) return null;

  return (
    <ModalCard title="AI Assistant Settings" onClose={onClose} size="lg">
      {({ close }) => (
        <div className="p-5 space-y-6 max-h-[75vh] overflow-y-auto">
          <div className="space-y-3">
            <h3 className="text-sm font-mono font-medium text-primary flex items-center gap-2">
              <Cpu size={16} />
              Agents
            </h3>
            {settings?.agents?.map((agent, idx) => (
              <Card key={idx} padding={false} className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <input
                    type="text"
                    value={agent.id || ""}
                    onChange={(e) => updateAgent(idx, "id", e.target.value)}
                    className="bg-primary text-secondary rounded-pill px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent flex-1 border border-primary/10"
                    placeholder="Agent ID"
                  />
                  <button
                    type="button"
                    onClick={() => removeAgent(idx)}
                    className="text-error hover:bg-error/10 rounded-pill p-1.5 motion-safe:transition-colors shrink-0"
                    aria-label="Remove agent"
                  >
                    <Trash size={14} />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-accent mb-1">Model</label>
                    {availableModels.length > 0 || fetchedModels.length > 0 ? (
                      <Dropdown
                        value={agent.model || ""}
                        onChange={(val) => updateAgent(idx, "model", val)}
                        fullWidth
                        bg="primary"
                        placeholder="Select a model"
                        options={[...availableModels, ...fetchedModels].map((m) => ({ value: m.id, label: m.id }))}
                      />
                    ) : (
                      <input
                        type="text"
                        value={agent.model || ""}
                        onChange={(e) => updateAgent(idx, "model", e.target.value)}
                        className="w-full bg-primary text-secondary rounded-pill px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent border border-primary/10"
                        placeholder="gpt-4o"
                      />
                    )}
                  </div>
                  <div>
                    <label className="block text-xs text-accent mb-1">Max Turns</label>
                    <input
                      type="number"
                      value={agent.max_turns || 0}
                      onChange={(e) => updateAgent(idx, "max_turns", parseInt(e.target.value, 10) || 0)}
                      className="w-full bg-primary text-secondary rounded-pill px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent border border-primary/10"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-accent mb-1">Permission Mode</label>
                  <Dropdown
                    value={agent.permission_mode || "standard"}
                    onChange={(val) => updateAgent(idx, "permission_mode", val)}
                    fullWidth
                    bg="primary"
                    options={[
                      { value: "standard", label: "Standard" },
                      { value: "approve_every_call", label: "Approve Every Call" },
                      { value: "auto", label: "Auto (no prompts)" },
                    ]}
                  />
                </div>
              </Card>
            ))}
            <Button variant="accent" onClick={addAgent} className="w-full">
              <Plus size={16} />
              Add Agent
            </Button>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-mono font-medium text-primary">Global Behavior</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-accent mb-1">Max Turns (default)</label>
                <input
                  type="number"
                  value={settings?.agent_max_turns || 20}
                  onChange={(e) => updateField("agent_max_turns", parseInt(e.target.value, 10) || 0)}
                  className="w-full bg-primary text-secondary rounded-pill px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent border border-primary/10"
                />
              </div>
              <div>
                <label className="block text-xs text-accent mb-1">Turn Timeout</label>
                <Dropdown
                  value={settings?.agent_turn_timeout || "2m0s"}
                  onChange={(val) => updateField("agent_turn_timeout", val)}
                  fullWidth
                  bg="primary"
                  options={[
                    { value: "1m0s", label: "1 min" },
                    { value: "2m0s", label: "2 min" },
                    { value: "5m0s", label: "5 min" },
                    { value: "10m0s", label: "10 min" },
                  ]}
                />
              </div>
            </div>
            <Toggle
              checked={settings?.snapshot_before_writes !== false}
              onChange={(v) => updateField("snapshot_before_writes", v)}
              label="Back Up Before Changes"
              description="Create a restore point before the assistant makes any changes"
            />
            <Toggle
              checked={settings?.self_healing || false}
              onChange={(v) => updateField("self_healing", v)}
              label="Self-Healing"
              description="Automatically detect and fix common problems"
            />
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-mono font-medium text-primary">API Key</h3>
            <Toggle
              checked={settings?.byok_enabled || false}
              onChange={(v) => updateField("byok_enabled", v)}
              label="Bring Your Own Key"
              description="Use your own AI provider instead of the system default"
            />
            {settings?.byok_enabled && (
              <div className="space-y-3 pt-2">
                <div>
                  <label className="block text-xs text-accent mb-1">API Format</label>
                  <Dropdown
                    value={settings?.user_api_format || "openai"}
                    onChange={(val) => updateField("user_api_format", val)}
                    fullWidth
                    bg="primary"
                    options={[
                      { value: "openai", label: "OpenAI (Chat Completions)" },
                      { value: "anthropic", label: "Anthropic (Messages)" },
                    ]}
                  />
                  <p className="text-xs text-accent mt-1">
                    Choose the format your provider uses. Most providers (OpenAI, Makora, Together, Groq) use OpenAI. Umans uses Anthropic.
                  </p>
                </div>
                <div>
                  <label className="block text-xs text-accent mb-1">API Key</label>
                  <input
                    type="password"
                    value={settings?.user_api_key || ""}
                    onChange={(e) => updateField("user_api_key", e.target.value)}
                    className="w-full bg-primary text-secondary rounded-pill px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent border border-primary/10"
                    placeholder="sk-..."
                  />
                </div>
                <div>
                  <label className="block text-xs text-accent mb-1">Provider URL</label>
                  <input
                    type="url"
                    value={settings?.user_base_url || ""}
                    onChange={(e) => updateField("user_base_url", e.target.value)}
                    className="w-full bg-primary text-secondary rounded-pill px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent border border-primary/10"
                    placeholder="https://api.openai.com/v1"
                  />
                </div>
                <Button
                  variant="accent"
                  size="sm"
                  onClick={fetchProviderModels}
                  disabled={isFetchingModels}
                  loading={isFetchingModels}
                  className="w-full"
                >
                  <Cpu size={14} />
                  {isFetchingModels ? "Fetching..." : "Fetch Models"}
                </Button>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="accent" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving} loading={saving}>
              <Save size={16} />
              Save Settings
            </Button>
          </div>
        </div>
      )}
    </ModalCard>
  );
}
