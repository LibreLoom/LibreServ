import { useState, useRef, useEffect } from "react";
import PropTypes from "prop-types";
import Card from "../cards/Card.jsx";
import ChatMessage from "./ChatMessage.jsx";
import ChatPermissionPrompt from "./ChatPermissionPrompt.jsx";
import ChatStreamingIndicator from "./ChatStreamingIndicator.jsx";
import ChatInputBar from "./ChatInputBar.jsx";
import ChatEmpty from "./ChatEmpty.jsx";
import Callout from "../common/Callout";
import ConversationSidebar from "./ConversationSidebar.jsx";

function HelpChatLayout({
  messages,
  events,
  isStreaming,
  conversations,
  activeConvId,
  onSelectConversation,
  onNewChat,
  onSend,
  onStop,
  pendingPermissions,
  onAllowPermission,
  onDenyPermission,
  onOpenSettings,
  error,
}) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, events]);

  const hasMessages = messages && messages.length > 0;
  const perms = pendingPermissions || events.filter((e) => e.type === "permission_request");

  function handleSend() {
    if (!input.trim()) return;
    onSend?.(input.trim());
    setInput("");
  }

  return (
    <div data-slot="help-chat-layout" className="mt-6 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
      <div className="flex flex-col">
        <Card noHeightAnim noPopIn padding={false} className="flex-1 flex flex-col min-h-[500px] max-h-[700px]">
          {error && (
            <div className="px-5 pt-4">
              <Callout tone="error" className="font-mono">{error}</Callout>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {!hasMessages ? (
              <ChatEmpty />
            ) : (
              <>
                {messages
                  .filter((msg) => msg.visibility !== "internal" && msg.role !== "system" && msg.role !== "tool")
                  .map((msg, i) => (
                    <ChatMessage key={msg.id || i} role={msg.role} content={msg.content} />
                  ))}

                {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
                  <ChatStreamingIndicator />
                )}

                {perms.map((perm) => (
                  <ChatPermissionPrompt
                    key={perm.id}
                    toolName={perm.tool_name}
                    reason={perm.reason}
                    onAllow={() => onAllowPermission?.(perm.id)}
                    onDeny={() => onDenyPermission?.(perm.id)}
                  />
                ))}

                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          <ChatInputBar
            value={input}
            onChange={setInput}
            onSend={handleSend}
            onStop={onStop}
            isStreaming={isStreaming}
          />
        </Card>
      </div>

      <div className="hidden lg:block">
        <ConversationSidebar
          conversations={conversations}
          activeId={activeConvId}
          onSelect={onSelectConversation}
          onNewChat={onNewChat}
          onOpenSettings={onOpenSettings}
        />
      </div>
    </div>
  );
}

HelpChatLayout.propTypes = {
  messages: PropTypes.array,
  events: PropTypes.array,
  isStreaming: PropTypes.bool,
  conversations: PropTypes.array,
  activeConvId: PropTypes.string,
  onSelectConversation: PropTypes.func,
  onNewChat: PropTypes.func,
  onSend: PropTypes.func,
  onStop: PropTypes.func,
  pendingPermissions: PropTypes.array,
  onAllowPermission: PropTypes.func,
  onDenyPermission: PropTypes.func,
  onOpenSettings: PropTypes.func,
  error: PropTypes.string,
};

export default HelpChatLayout;
