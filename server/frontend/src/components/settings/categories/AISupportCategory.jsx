import { Bot, Key, Cpu, ShieldCheck } from "lucide-react";
import SettingsCard from "../SettingsCard.jsx";
import Toggle from "../../common/Toggle.jsx";
import Dropdown from "../../common/Dropdown.jsx";
import ValueDisplay from "../../common/ValueDisplay.jsx";

export default function AISupportCategory({ settings, onSettingsChange }) {
  const ai = settings?.ai_support || {};

  function update(field, value) {
    onSettingsChange?.({ ...ai, [field]: value });
  }

  return (
    <div className="space-y-4">
      <SettingsCard icon={Bot} title="AI Assistant" padding={false} index={0}>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-primary">Default Model</div>
              <div className="text-sm text-accent mt-0.5">
                Which AI model the assistant uses to understand and respond to your questions
              </div>
            </div>
            <Dropdown
              value={ai.default_model || "route/mimo-v2.5-pro"}
              onChange={(val) => update("default_model", val)}
              width={200}
              bg="primary"
              options={[
                { value: "route/mimo-v2.5-pro", label: "MiMo V2.5 Pro" },
                { value: "route/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
                { value: "route/kimi-k2.6", label: "Kimi K2.6" },
                { value: "route/deepseek-v3.2", label: "DeepSeek V3.2" },
              ]}
            />
          </div>
          <ValueDisplay
            label="Inference Provider"
            value={ai.inference_base_url || "Not configured"}
          />
          <ValueDisplay
            label="API Key"
            value={ai.api_key_configured ? "Configured" : "Not set — contact your administrator"}
          />
        </div>
      </SettingsCard>

      <SettingsCard icon={Key} title="Bring Your Own Key" padding={false} index={1}>
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-primary/60">
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
                <p className="text-xs text-primary/40 mt-1">
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
                <p className="text-xs text-primary/40 mt-1">
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
              <div className="text-sm text-accent mt-0.5">
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
              <div className="text-sm text-accent mt-0.5">
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
              <div className="text-sm text-accent mt-0.5">
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
          <p className="text-sm text-primary/60">
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
