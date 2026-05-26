import { useState, useEffect, useMemo, useCallback } from "react";
import { AlertCircle } from "lucide-react";
import HeaderCard from "../components/cards/HeaderCard.jsx";
import Card from "../components/cards/Card.jsx";
import Button from "../components/ui/Button.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import Alert from "../components/common/Alert.jsx";
import HelpChatLayout from "../components/help/HelpChatLayout.jsx";
import PlanPicker from "../components/help/PlanPicker.jsx";
import { useAgentChat } from "../hooks/useAgentChat.jsx";

const PLAN_PICKER_DISMISSED_KEY = "libreserv_plan_picker_dismissed";

export default function HelpPage() {
  const chat = useAgentChat();
  const [aiConfigured, setAiConfigured] = useState(null);
  const [permissionMode, setPermissionMode] = useState("standard");
  const [model, setModel] = useState("");
  const [planPickerDismissed, setPlanPickerDismissed] = useState(
    () => localStorage.getItem(PLAN_PICKER_DISMISSED_KEY) === "true"
  );
  const [dismissedPerms, setDismissedPerms] = useState(new Set());

  useEffect(() => {
    chat.loadConversations();
    chat.loadSubscription();
    chat.loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/settings/ai-support", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (cancelled) return;
        const ai = data?.ai_support || {};
        setAiConfigured(
          ai.device_token_set === true ||
            (ai.byok_enabled && ai.user_key_configured)
        );
      })
      .catch(() => {
        if (!cancelled) setAiConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const planId =
    chat.subscription?.plan?.id ||
    chat.subscription?.subscription?.plan_id ||
    "basic";
  const showPlanPicker =
    !planPickerDismissed && planId === "free" && aiConfigured;

  const creditUsed = chat.subscription?.usage?.used_usd || 0;
  const creditCap = chat.subscription?.plan?.credit_cap_usd || 0;
  const planName = chat.subscription?.plan?.name || "";

  const isStreaming =
    chat.status === "streaming" || chat.status === "sending";

  const pendingPermissions = useMemo(() => {
    const pending = {};
    for (const evt of chat.events) {
      if (
        evt.type === "permission_request" &&
        !dismissedPerms.has(evt.id)
      ) {
        pending[evt.id] = evt;
      }
      if (evt.type === "tool_result" && evt.id) {
        delete pending[evt.id];
      }
    }
    return Object.values(pending);
  }, [chat.events, dismissedPerms]);

  const conversationsForSidebar = useMemo(
    () =>
      chat.conversations.slice(0, 10).map((conv) => ({
        id: conv.id,
        title:
          conv.trigger_type === "manual"
            ? "Manual"
            : conv.trigger_app_id || "Chat",
        date: conv.created_at
          ? new Date(conv.created_at).toLocaleDateString()
          : "",
        status: conv.status,
      })),
    [chat.conversations]
  );

  const modelOptions = useMemo(
    () =>
      chat.models.map((m) => ({
        value: m.id,
        label: m.name || m.id,
      })),
    [chat.models]
  );

  const handleSend = useCallback(
    async (text) => {
      const content = (text || "").trim();
      if (!content) return;

      if (!chat.activeConv?.id) {
        const conv = await chat.startConversation({
          permissionMode,
          models: model ? [model] : [],
        });
        if (!conv) return;
        const sent = await chat.sendMessage(conv.id, content);
        if (sent) chat.streamEvents(conv.id);
        return;
      }

      const sent = await chat.sendMessage(chat.activeConv.id, content);
      if (sent) chat.streamEvents(chat.activeConv.id);
    },
    [chat, permissionMode, model]
  );

  const handleAllowPermission = useCallback(
    (toolCallId) => {
      if (!chat.activeConv) return;
      setDismissedPerms((prev) => new Set([...prev, toolCallId]));
      chat.respondPermission(chat.activeConv.id, toolCallId, true);
    },
    [chat]
  );

  const handleDenyPermission = useCallback(
    (toolCallId) => {
      if (!chat.activeConv) return;
      setDismissedPerms((prev) => new Set([...prev, toolCallId]));
      chat.respondPermission(chat.activeConv.id, toolCallId, false);
    },
    [chat]
  );

  const handleStop = useCallback(() => {
    if (!chat.activeConv) return;
    chat.stopConversation(chat.activeConv.id);
  }, [chat]);

  const handleNewChat = useCallback(() => {
    chat.resetChat();
  }, [chat]);

  const handleSelectConversation = useCallback(
    (convId) => {
      chat.loadConversation(convId);
    },
    [chat]
  );

  const handlePlanSelect = useCallback(
    async (selectedPlanId) => {
      await chat.selectPlan(selectedPlanId);
      setPlanPickerDismissed(true);
      localStorage.setItem(PLAN_PICKER_DISMISSED_KEY, "true");
      chat.loadSubscription();
    },
    [chat]
  );

  const handlePlanSkip = useCallback(() => {
    setPlanPickerDismissed(true);
    localStorage.setItem(PLAN_PICKER_DISMISSED_KEY, "true");
  }, []);

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
      ></HeaderCard>

      {chat.error && (
        <div className="mt-4">
          <Alert
            variant="error"
            message={chat.error}
            className="max-w-2xl"
          />
          <button
            type="button"
            onClick={() => chat.setError(null)}
            className="ml-3 mt-1 text-xs text-error/70 hover:text-error underline motion-safe:transition-colors cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {aiConfigured === null && (
        <div className="mt-6 flex justify-center">
          <Card
            noHeightAnim
            noPopIn
            className="w-[70vw] sm:w-[20vw] text-center"
          >
            <p className="text-sm text-primary/70 font-mono">
              Loading...
            </p>
          </Card>
        </div>
      )}

      {aiConfigured === false && (
        <div className="mt-6">
          <Card noHeightAnim noPopIn>
            <EmptyState
              icon={AlertCircle}
              title="AI Support Not Configured"
              description="Set up your AI provider in Settings to enable the help assistant. You need a subscription or your own API key."
              action={
                <a href="/settings#ai_support">
                  <Button variant="primary" size="md">
                    Set up AI Support
                  </Button>
                </a>
              }
            />
          </Card>
        </div>
      )}

      {showPlanPicker && (
        <div className="mt-6">
          <PlanPicker
            currentPlanId={planId}
            onSelect={handlePlanSelect}
            onSkip={handlePlanSkip}
            plans={chat.subscription?.available_plans || []}
          />
        </div>
      )}

      {aiConfigured === true && !showPlanPicker && (
        <HelpChatLayout
          messages={chat.messages}
          events={chat.events}
          isStreaming={isStreaming}
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          model={model}
          onModelChange={setModel}
          modelOptions={modelOptions}
          creditUsed={creditUsed}
          creditCap={creditCap}
          planName={planName}
          conversations={conversationsForSidebar}
          activeConvId={chat.activeConv?.id}
          onSelectConversation={handleSelectConversation}
          onNewChat={handleNewChat}
          onSend={handleSend}
          onStop={handleStop}
          onAllowPermission={handleAllowPermission}
          onDenyPermission={handleDenyPermission}
          pendingPermissions={pendingPermissions}
          error={null}
        />
      )}
    </main>
  );
}
