import { useState, useEffect, useMemo, useCallback } from "react";
import { AlertCircle, Globe, Key } from "lucide-react";
import HeaderCard from "../components/cards/HeaderCard.jsx";
import Card from "../components/cards/Card.jsx";
import Button from "../components/ui/Button.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import HelpChatLayout from "../components/help/HelpChatLayout.jsx";
import { useAgentChat } from "../hooks/useAgentChat.jsx";
import { useAuth } from "../hooks/useAuth.jsx";
import { useToast } from "../context/ToastContext";

export default function HelpPage() {
  const chat = useAgentChat();
  useAuth();
  const { addToast } = useToast();
  const [aiConfigured, setAiConfigured] = useState(null);
  const [dismissedPerms, setDismissedPerms] = useState(new Set());

  useEffect(() => {
    if (aiConfigured === true) {
      chat.loadConversations();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiConfigured]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/settings/ai-support", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (cancelled) return;
        const ai = data?.ai_support || {};
        const hasBYOK = ai.byok_enabled === true && ai.user_key_configured === true;
        const hasModel = !!ai.main_model;
        setAiConfigured(hasBYOK || hasModel);
      })
      .catch(() => {
        if (!cancelled) setAiConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Surface agent-chat errors as toasts so the user always sees them
  useEffect(() => {
    if (!chat.error) return;
    addToast({ type: "error", message: chat.error });
  }, [chat.error, addToast]);

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
        title: conv.title || "Conversation",
        date: conv.created_at
          ? new Date(conv.created_at).toLocaleDateString()
          : "",
        status: conv.status,
      })),
    [chat.conversations]
  );

  const handleSend = useCallback(
    async (text) => {
      if (isStreaming) return;
      const content = (text || "").trim();
      if (!content) return;

      if (!chat.activeConv?.id || chat.activeConv.status !== "active") {
        if (chat.activeConv?.status && chat.activeConv.status !== "active") {
          chat.resetChat();
        }
        const conv = await chat.startConversation();
        if (!conv) {
          addToast({
            type: "error",
            message: "Could not start a conversation. Check your AI settings.",
          });
          return;
        }
        const sent = await chat.sendMessage(conv.id, content);
        if (sent) chat.streamEvents(conv.id);
        return;
      }

      const sent = await chat.sendMessage(chat.activeConv.id, content);
      if (sent) chat.streamEvents(chat.activeConv.id);
    },
    [chat, isStreaming, addToast]
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
      />

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
          <Card noHeightAnim className="max-w-2xl mx-auto">
            <EmptyState
              icon={AlertCircle}
              title="AI Support Not Configured"
              description="To use the help assistant you need AI access. Choose how you want to connect."
              action={
                <div className="space-y-3">
                  <Button
                    variant="primary"
                    size="md"
                    className="w-full"
                    onClick={() => { window.location.href = "/settings#external_services"; }}
                  >
                    <Globe size={16} />
                    Set up via LibreServ Connect
                  </Button>
                  <p className="text-xs text-primary/60 max-w-sm mx-auto px-4">
                    Connect bundles AI, backups, email and more. Or use your own key from a provider like{" "}
                    <button
                      type="button"
                      onClick={() => { window.open("https://portal.neuralwatt.com/auth/register?ref=NW-MAX-YRBX", "_blank"); }}
                      className="link-accent-card bg-transparent border-none p-0 cursor-pointer"
                    >
                      Neuralwatt
                    </button>.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() => { window.location.href = "/settings#external_services"; }}
                  >
                    <Key size={14} />
                    Bring your own AI key
                  </Button>
                </div>
              }
            />
          </Card>
        </div>
      )}

      {aiConfigured === true && (
        <HelpChatLayout
          messages={chat.messages}
          events={chat.events}
          isStreaming={isStreaming}
          conversations={conversationsForSidebar}
          activeConvId={chat.activeConv?.id}
          onSelectConversation={handleSelectConversation}
          onNewChat={handleNewChat}
          onSend={handleSend}
          onStop={handleStop}
          onAllowPermission={handleAllowPermission}
          onDenyPermission={handleDenyPermission}
          pendingPermissions={pendingPermissions}
          onOpenSettings={() => { window.location.href = "/settings#external_services"; }}
          error={chat.error}
        />
      )}

    </main>
  );
}
