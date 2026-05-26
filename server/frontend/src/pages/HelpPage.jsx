import { useState, useEffect, useRef, useMemo } from "react";
import { Send, StopCircle, Plus, Bot, User, Shield, Camera, ChevronDown, AlertCircle } from "lucide-react";
import HeaderCard from "../components/cards/HeaderCard.jsx";
import Card from "../components/cards/Card.jsx";
import Button from "../components/ui/Button.jsx";
import AgentTrace from "../components/agent/AgentTrace.jsx";
import PlanPicker from "../components/agent/PlanPicker.jsx";
import { useAgentChat } from "../hooks/useAgentChat.jsx";

const PLAN_PICKER_DISMISSED_KEY = "libreserv_plan_picker_dismissed";

export default function HelpPage() {
  const chat = useAgentChat();
  const [input, setInput] = useState("");
  const [dismissedPerms, setDismissedPerms] = useState(new Set());
  const [planPickerDismissed, setPlanPickerDismissed] = useState(
    () => localStorage.getItem(PLAN_PICKER_DISMISSED_KEY) === "true"
  );
  const [permissionMode, setPermissionMode] = useState("standard");
  const [showModelConfig, setShowModelConfig] = useState(false);
  const [selectedModels, setSelectedModels] = useState([]);
  const [aiConfigured, setAiConfigured] = useState(true);
  const messagesEndRef = useRef(null);

  const { loadConversations, loadSubscription, loadModels } = chat;

  async function checkAiConfigured() {
    try {
      const res = await fetch("/api/v1/settings/ai-support", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        const ai = data?.ai_support || {};
        const configured = ai.device_token_set === true ||
                          (ai.byok_enabled && ai.user_key_configured);
        setAiConfigured(configured);
      }
    } catch {
      // network error - silently ignore
    }
  }

  useEffect(() => {
    loadConversations();
    loadSubscription();
    loadModels();
    checkAiConfigured(); // eslint-disable-line react-hooks/set-state-in-effect
  }, [loadConversations, loadSubscription, loadModels]);

  const planId = chat.subscription?.plan?.id || chat.subscription?.subscription?.plan_id;
  const showPlanPicker = planId === "free" && !planPickerDismissed;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages, chat.events]);

  async function handleStart() {
    await chat.startConversation({
      permissionMode,
      models: selectedModels,
    });
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || !chat.activeConv) return;
    setInput("");

    if (!chat.activeConv?.id) {
      const conv = await chat.startConversation({
        permissionMode,
        models: selectedModels,
      });
      if (!conv) return;
      const sent = await chat.sendMessage(conv.id, text);
      if (sent) chat.streamEvents(conv.id);
      return;
    }

    const sent = await chat.sendMessage(chat.activeConv.id, text);
    if (sent) chat.streamEvents(chat.activeConv.id);
  }

  async function handlePermission(toolCallId, approved) {
    if (!chat.activeConv) return;
    setDismissedPerms((prev) => new Set([...prev, toolCallId]));
    await chat.respondPermission(chat.activeConv.id, toolCallId, approved);
  }

  async function handleStop() {
    if (!chat.activeConv) return;
    await chat.stopConversation(chat.activeConv.id);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handlePlanSelect(planId) {
    await chat.selectPlan(planId);
    setPlanPickerDismissed(true);
    localStorage.setItem(PLAN_PICKER_DISMISSED_KEY, "true");
    chat.loadSubscription();
  }

  function handlePlanSkip() {
    setPlanPickerDismissed(true);
    localStorage.setItem(PLAN_PICKER_DISMISSED_KEY, "true");
  }

  function addModelSlot() {
    const available = availableModelList.filter((m) => !selectedModels.includes(m.id));
    if (available.length > 0) {
      setSelectedModels((prev) => [...prev, available[0].id]);
    }
  }

  function removeModelSlot(index) {
    if (selectedModels.length <= 2) return;
    setSelectedModels((prev) => prev.filter((_, i) => i !== index));
  }

  function changeModelSlot(index, modelId) {
    setSelectedModels((prev) => prev.map((m, i) => (i === index ? modelId : m)));
  }

  const pendingPermissions = useMemo(() => {
    const pending = {};
    for (const evt of chat.events) {
      if (evt.type === "permission_request" && !dismissedPerms.has(evt.id)) {
        pending[evt.id] = evt;
      }
      if (evt.type === "tool_result" && evt.id) {
        delete pending[evt.id];
      }
    }
    return pending;
  }, [chat.events, dismissedPerms]);

  const snapshotEvents = useMemo(
    () => chat.events.filter((e) => e.type === "snapshot_created"),
    [chat.events]
  );

  const isStreaming = chat.status === "streaming" || chat.status === "sending";

  const availableModelList = chat.models;

  const creditUsed = chat.subscription?.usage?.used_usd || 0;
  const creditCap = chat.subscription?.plan?.credit_cap_usd || 0;
  const creditPct = creditCap > 0 ? (creditUsed / creditCap) * 100 : 0;

  return (
    <main
      className="bg-primary text-secondary px-8 pt-5 pb-32"
      aria-labelledby="help-title"
      id="main-content"
      tabIndex={-1}
    >
      <HeaderCard
        id="help-title"
        title="Help"
        leftContent={null}
        rightContent={null}
        bottomContent={
          <p className="text-sm text-primary/70 mt-1">
            Ask our AI assistant about your server, apps, or any issues. Multiple agents work together to diagnose and fix problems.
          </p>
        }
      >
        {!aiConfigured && (
          <div className="bg-warning/10 border border-warning/20 rounded-large-element p-4 text-center">
            <AlertCircle className="text-warning mx-auto mb-2" size={24} />
            <h3 className="text-primary font-mono mb-1">AI Support Not Configured</h3>
            <p className="text-sm text-primary/60 mb-3">
              Set up your AI provider in Settings to enable the help assistant.
            </p>
            <a href="/settings#ai_support">
              <Button variant="primary" size="sm">
                Get Started with Help
              </Button>
            </a>
          </div>
        )}
      </HeaderCard>

      {chat.error && (
        <div className="bg-error/10 text-error rounded-large-element p-4 mt-4 font-mono text-sm" role="alert">
          {chat.error}
          <button
            className="ml-3 underline text-error hover:text-error/80"
            onClick={() => chat.setError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {showPlanPicker && (
        <div className="mt-6">
          <PlanPicker
            currentPlanId={chat.subscription?.plan?.id || "free"}
            onSelect={handlePlanSelect}
            onSkip={handlePlanSkip}
          />
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6">
        <div className="flex flex-col">
          {!chat.activeConv ? (
            <Card noHeightAnim noPopIn className="flex-1 flex flex-col items-center justify-center min-h-[400px]">
              <div className="text-center max-w-md">
                {!aiConfigured ? (
                  <>
                    <AlertCircle size={48} className="text-warning mx-auto mb-4" />
                    <h2 className="text-lg font-mono text-primary mb-2">AI Support Not Configured</h2>
                    <p className="text-sm text-primary/60 mb-4">
                      Set up your AI provider in Settings to enable the help assistant.
                    </p>
                    <a href="/settings#ai_support">
                      <Button variant="primary" size="md">
                        Get Started with Help
                      </Button>
                    </a>
                  </>
                ) : (
                  <>
                    <Bot size={48} className="text-accent mx-auto mb-4" />
                    <h2 className="text-lg font-mono text-primary mb-2">How can we help?</h2>
                    <p className="text-sm text-primary/60 mb-4">
                      Our AI agents work together to check your apps, read logs, diagnose issues, and fix problems. Just describe what you need.
                    </p>

                    <button
                      type="button"
                      onClick={() => setShowModelConfig(!showModelConfig)}
                      className="flex items-center gap-1 mx-auto mb-4 text-xs text-primary/50 hover:text-primary/70 cursor-pointer"
                    >
                      <span>{selectedModels.length} agents configured</span>
                      <ChevronDown size={12} className={showModelConfig ? "rotate-180" : ""} />
                    </button>

                    {showModelConfig && (
                      <div className="bg-primary/5 rounded-large-element p-4 mb-4 text-left">
                        <p className="text-xs text-primary/40 mb-3 uppercase tracking-wider">Agent Models</p>
                        {selectedModels.map((modelId, i) => {
                          return (
                            <div key={i} className="flex items-center gap-2 mb-2">
                              <span className="text-xs text-primary/60 font-mono w-16">Agent {i + 1}</span>
                              <select
                                value={modelId}
                                onChange={(e) => changeModelSlot(i, e.target.value)}
                                className="flex-1 bg-primary text-secondary rounded-large-element px-2 py-1 text-xs border border-primary/10"
                              >
                                {availableModelList.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {m.name || m.id}
                                  </option>
                                ))}
                              </select>
                              {selectedModels.length > 2 && (
                                <button
                                  type="button"
                                  onClick={() => removeModelSlot(i)}
                                  className="text-primary/30 hover:text-error text-xs"
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          onClick={addModelSlot}
                          className="text-xs text-accent hover:text-accent/80 mt-1"
                        >
                          + Add Agent
                        </button>
                        <p className="text-[10px] text-primary/30 mt-2">
                          Minimum 2 agents required for consensus. More agents = broader perspective but higher credit usage.
                        </p>
                      </div>
                    )}

                    <Button variant="primary" size="md" onClick={handleStart}>
                      <Plus size={16} /> Start a Conversation
                    </Button>
                  </>
                )}
              </div>
            </Card>
          ) : (
            <>
              <Card noHeightAnim noPopIn padding={false} className="flex-1 flex flex-col min-h-[400px] max-h-[600px]">
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                  {chat.messages.map((msg, i) => (
                    <div
                      key={i}
                      className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      {msg.role === "assistant" && (
                        <div className="shrink-0 w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center">
                          <Bot size={16} className="text-primary" />
                        </div>
                      )}
                      <div
                        className={`max-w-[80%] rounded-large-element px-4 py-2.5 text-sm ${
                          msg.role === "user"
                            ? "bg-primary text-secondary"
                            : "bg-accent/10 text-primary"
                        }`}
                      >
                        {msg.content}
                      </div>
                      {msg.role === "user" && (
                        <div className="shrink-0 w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center">
                          <User size={16} className="text-primary" />
                        </div>
                      )}
                    </div>
                  ))}

                  {isStreaming && chat.messages[chat.messages.length - 1]?.role !== "assistant" && (
                    <div className="flex gap-3 justify-start">
                      <div className="shrink-0 w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center">
                        <Bot size={16} className="text-primary" />
                      </div>
                      <div className="bg-accent/10 text-primary rounded-large-element px-4 py-2.5 text-sm">
                        <span className="inline-flex gap-1">
                          <span className="animate-bounce">.</span>
                          <span className="animate-bounce [animation-delay:0.1s]">.</span>
                          <span className="animate-bounce [animation-delay:0.2s]">.</span>
                        </span>
                      </div>
                    </div>
                  )}

                  {Object.values(pendingPermissions).map((perm) => (
                    <div key={perm.id} className="bg-warning/10 rounded-large-element p-4" role="alert">
                      <div className="flex items-start gap-2">
                        <Shield size={18} className="text-warning shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <p className="text-sm font-mono text-primary mb-1">
                            The agent needs to use: {perm.tool_name}
                          </p>
                          <p className="text-xs text-primary/60 mb-3">{perm.reason}</p>
                          <div className="flex gap-2">
                            <Button variant="primary" size="sm" onClick={() => handlePermission(perm.id, true)}>
                              Allow this time
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => handlePermission(perm.id, false)}>
                              Deny
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}

                  {snapshotEvents.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {snapshotEvents.map((s, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 rounded-pill bg-success/10 text-success px-2 py-1 text-[10px] font-mono"
                        >
                          <Camera size={8} />
                          Restore point created
                        </span>
                      ))}
                    </div>
                  )}

                  <AgentTrace events={chat.events} />

                  <div ref={messagesEndRef} />
                </div>

                <div className="border-t border-primary/10 p-3">
                  <div className="flex gap-2 items-center">
                    <select
                      value={permissionMode}
                      onChange={(e) => setPermissionMode(e.target.value)}
                      className="bg-primary text-secondary rounded-pill px-2 py-1 text-[10px] border border-primary/10"
                      aria-label="Permission mode"
                    >
                      <option value="standard">Standard</option>
                      <option value="approve_every_call">Approve Every Call</option>
                    </select>
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Describe what you need help with..."
                      disabled={isStreaming}
                      rows={1}
                      className="flex-1 bg-primary text-secondary rounded-large-element px-4 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-secondary/40"
                      aria-label="Type your message"
                    />
                    {isStreaming ? (
                      <Button variant="danger" size="md" onClick={handleStop} aria-label="Stop the assistant">
                        <StopCircle size={16} /> Stop
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        size="md"
                        onClick={handleSend}
                        disabled={!input.trim()}
                        aria-label="Send message"
                      >
                        <Send size={16} />
                      </Button>
                    )}
                  </div>
                </div>
              </Card>

              {chat.subscription?.usage && (
                <div className="mt-2 flex items-center gap-3 text-xs text-secondary/50 font-mono">
                  <span className={creditPct > 80 ? "text-error" : ""}>
                    Credit used: ${creditUsed.toFixed(2)} / ${creditCap.toFixed(2)}
                  </span>
                  {chat.subscription.plan && (
                    <span className="rounded-pill bg-accent/10 text-primary/60 px-2 py-0.5">
                      {chat.subscription.plan.name}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="space-y-4">
          <Card noHeightAnim noPopIn icon={null} title="Recent Conversations">
            {chat.conversations.length === 0 ? (
              <p className="text-sm text-primary/50">No conversations yet</p>
            ) : (
              <div className="space-y-1">
                {chat.conversations.slice(0, 10).map((conv) => (
                  <button
                    key={conv.id}
                    onClick={() => chat.loadConversation(conv.id)}
                    className={`w-full text-left px-3 py-2 rounded-large-element text-sm font-mono transition-colors ${
                      chat.activeConv?.id === conv.id
                        ? "bg-accent/20 text-primary"
                        : "hover:bg-primary/5 text-primary/70"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate">
                        {conv.trigger_type === "manual" ? "Manual" : conv.trigger_app_id || "Chat"}
                      </span>
                      <span
                        className={`text-xs rounded-pill px-2 py-0.5 ${
                          conv.status === "active"
                            ? "bg-success/10 text-success"
                            : conv.status === "resolved"
                              ? "bg-accent/10 text-primary/50"
                              : "bg-error/10 text-error"
                        }`}
                      >
                        {conv.status}
                      </span>
                    </div>
                    <div className="text-xs text-primary/40 mt-0.5">
                      {new Date(conv.created_at).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </main>
  );
}
