import { Bot, Key, Cpu, ShieldCheck, AlertCircle } from "lucide-react";
import SettingsCard from "../SettingsCard.jsx";
import Toggle from "../../common/Toggle.jsx";
import Dropdown from "../../common/Dropdown.jsx";
import ValueDisplay from "../../common/ValueDisplay.jsx";

export default function AISupportCategory({ settings, onSettingsChange }) {
  const ai = settings?.ai_support || {};
  const availableModels = ai.available_models || [];
  const modelOptions = availableModels.map((m) => ({
    value: m.id,
    label: m.id,
  }));

  const isConfigured = ai.device_token_set === true ||
                        (ai.byok_enabled && ai.user_key_configured);

  function update(field, value) {
    onSettingsChange?.({ ...ai, [field]: value });
  }

  return (
    <div className="space-y-4">
      {!isConfigured && (
        <div className="bg-warning/10 border border-warning/20 rounded-large-element p-4 flex items-start gap-3">
          <AlertCircle className="text-warning shrink-0 mt-0.5" size={20} />
          <div className="flex-1">
            <h3 className="text-secondary font-mono text-sm mb-1">AI Support Not Configured</h3>
            <p className="text-sm text-secondary/70 mb-3">
              Connect to the LibreServ support service to enable the AI help assistant. Your administrator should provide the server address, device token, and device ID.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-sm text-secondary block mb-1" htmlFor="server-url">
                  Support Server Address
                </label>
                <input
                  id="server-url"
                  type="url"
                  placeholder="https://support.serv.libreloom.org"
                  value={ai.server_url || ""}
                  onChange={(e) => update("server_url", e.target.value)}
                  className="w-full bg-primary text-secondary rounded-large-element px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-secondary/40 border border-primary/10"
                />
                <p className="text-xs text-secondary/70 mt-1">
                  The address of the LibreServ support service that provides AI capabilities to your server.
                </p>
              </div>
              <div>
                <label className="text-sm text-secondary block mb-1" htmlFor="device-token">
                  Device Token
                </label>
                <input
                  id="device-token"
                  type="password"
                  placeholder="Your device token"
                  value={ai.device_token || ""}
                  onChange={(e) => update("device_token", e.target.value)}
                  className="w-full bg-primary text-secondary rounded-large-element px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-secondary/40 border border-primary/10"
                />
                <p className="text-xs text-secondary/70 mt-1">
                  This authenticates your server to the support service. Your administrator provides this when setting up your subscription.
                </p>
              </div>
              <div>
                <label className="text-sm text-secondary block mb-1" htmlFor="device-id">
                  Device ID
                </label>
                <input
                  id="device-id"
                  type="text"
                  placeholder="your-server-name"
                  value={ai.device_id || ""}
                  onChange={(e) => update("device_id", e.target.value)}
                  className="w-full bg-primary text-secondary rounded-large-element px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-secondary/40 border border-primary/10"
                />
                <p className="text-xs text-secondary/70 mt-1">
                  A unique name for this server, used to identify your subscription and track credit usage.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      <SettingsCard icon={Bot} title="AI Assistant" padding={false} index={0}>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-primary">Default Model</div>
              <div className="text-sm text-primary/70 mt-0.5">
                Which AI model the assistant uses to understand and respond to your questions
              </div>
            </div>
            <Dropdown
              value={ai.default_model || ""}
              onChange={(val) => update("default_model", val)}
              width={200}
              bg="primary"
              placeholder={modelOptions.length === 0 ? "No models found" : "Select a model"}
              options={modelOptions}
            />
          </div>
          <ValueDisplay
            label="Support Service"
            value={ai.server_url || "Not configured"}
          />
          <ValueDisplay
            label="Connection"
            value={ai.device_token_set ? "Connected" : "Not set — contact your administrator"}
          />
        </div>
      </SettingsCard>

      <SettingsCard icon={Key} title="Bring Your Own Key" padding={false} index={1}>
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-primary/70">
            If your administrator has enabled this, you can use your own AI provider API key instead of the shared one. Your key is stored securely and never shared with other users.
          </p>
          <Toggle
            checked={ai.byok_enabled || false}
            onChange={(val) => update("byok_enabled", val)}
            label="Use Your Own API Key"
            description="Provide your own AI provider key for the assistant"
          />
          {ai.byok_enabled && (
            <div className="space-y-3 mt-2 pt-3 border-t border-primary/10">
              <div>
                <label className="text-sm text-primary block mb-1" htmlFor="user-api-key">
                  Your API Key
                </label>
                <input
                  id="user-api-key"
                  type="password"
                  placeholder="sk-..."
                  value={ai.user_api_key || ""}
                  onChange={(e) => update("user_api_key", e.target.value)}
                  className="w-full bg-primary text-secondary rounded-large-element px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-secondary/40 border border-primary/10"
                />
                <p className="text-xs text-primary/60 mt-1">
                  {ai.user_key_configured
                    ? "A key is already saved. Enter a new one to replace it."
                    : "Find your key on your AI provider's website under Settings or API Keys."}
                </p>
              </div>
              <div>
                <label className="text-sm text-primary block mb-1" htmlFor="user-base-url">
                  Provider URL
                </label>
                <input
                  id="user-base-url"
                  type="url"
                  placeholder="https://api.openai.com/v1"
                  value={ai.user_base_url || ""}
                  onChange={(e) => update("user_base_url", e.target.value)}
                  className="w-full bg-primary text-secondary rounded-large-element px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-secondary/40 border border-primary/10"
                />
                <p className="text-xs text-primary/60 mt-1">
                  Only change this if your provider uses a different address than the default.
                </p>
              </div>
            </div>
          )}
        </div>
      </SettingsCard>

      <SettingsCard icon={Cpu} title="Agent Behavior" padding={false} index={2}>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-primary">Billing Mode</div>
              <div className="text-sm text-primary/70 mt-0.5">
                How credit costs are calculated — per token used, or a flat amount per request
              </div>
            </div>
            <Dropdown
              value={ai.billing_mode || "token"}
              onChange={(val) => update("billing_mode", val)}
              width={120}
              bg="primary"
              options={[
                { value: "token", label: "Per Token" },
                { value: "request", label: "Per Request" },
              ]}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-primary">Max Steps Per Conversation</div>
              <div className="text-sm text-primary/70 mt-0.5">
                How many actions the assistant can take before asking you again
              </div>
            </div>
            <Dropdown
              value={String(ai.agent_max_turns || 20)}
              onChange={(val) => update("agent_max_turns", parseInt(val, 10))}
              width={80}
              bg="primary"
              options={[
                { value: "10", label: "10" },
                { value: "20", label: "20" },
                { value: "30", label: "30" },
                { value: "50", label: "50" },
              ]}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-primary">Time Per Step</div>
              <div className="text-sm text-primary/70 mt-0.5">
                How long the assistant waits for each action before giving up
              </div>
            </div>
            <Dropdown
              value={ai.agent_turn_timeout || "2m0s"}
              onChange={(val) => update("agent_turn_timeout", val)}
              width={100}
              bg="primary"
              options={[
                { value: "1m0s", label: "1 min" },
                { value: "2m0s", label: "2 min" },
                { value: "5m0s", label: "5 min" },
                { value: "10m0s", label: "10 min" },
              ]}
            />
          </div>
          <Toggle
            checked={ai.snapshot_before_writes !== false}
            onChange={(val) => update("snapshot_before_writes", val)}
            label="Automatic Backups Before Changes"
            description="The assistant creates a backup before making any changes so you can undo them"
          />
        </div>
      </SettingsCard>

      <SettingsCard icon={ShieldCheck} title="Self-Healing" padding={false} index={3}>
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-primary/70">
            When enabled, the assistant can automatically detect and fix common problems like crashed apps or unhealthy containers — without you needing to ask.
          </p>
          <Toggle
            checked={ai.self_healing || false}
            onChange={(val) => update("self_healing", val)}
            label="Enable Self-Healing"
            description="Let the assistant automatically fix detected problems"
          />
        </div>
      </SettingsCard>
    </div>
  );
}
