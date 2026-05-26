import { useState, useRef, useEffect } from "react";
import PropTypes from "prop-types";
import { Camera } from "lucide-react";
import Card from "../cards/Card.jsx";
import Pill from "../common/Pill.jsx";
import ChatHeader from "./ChatHeader.jsx";
import ChatMessage from "./ChatMessage.jsx";
import ChatPermissionPrompt from "./ChatPermissionPrompt.jsx";
import ChatStreamingIndicator from "./ChatStreamingIndicator.jsx";
import ChatInputBar from "./ChatInputBar.jsx";
import ChatEmpty from "./ChatEmpty.jsx";
import ConversationSidebar from "./ConversationSidebar.jsx";
import AgentTrace from "../agent/AgentTrace.jsx";

function HelpChatLayout({
  messages,
  events,
  isStreaming,
  permissionMode,
  onPermissionModeChange,
  model,
  onModelChange,
  modelOptions,
  creditUsed,
  creditCap,
  planName,
  conversations,
  activeConvId,
  onSelectConversation,
  onNewChat,
  onSend,
  onStop,
  pendingPermissions,
  onAllowPermission,
  onDenyPermission,
  error,
}) {
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, events]);

  const snapshotEvents = events.filter((e) => e.type === "snapshot_created");
  const hasMessages = messages && messages.length > 0;
  const perms = pendingPermissions || events.filter((e) => e.type === "permission_request");

  function handleSend() {
    if (!input.trim()) return;
    onSend?.(input.trim());
    setInput("");
  }

  function handleSuggestion(text) {
    onSend?.(text);
  }

  return (
    <div className="mt-6 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
      <div className="flex flex-col">
        <Card noHeightAnim noPopIn padding={false} className="flex-1 flex flex-col min-h-[500px] max-h-[700px]">
          <ChatHeader
            model={model}
            onModelChange={onModelChange}
            modelOptions={modelOptions}
            permissionMode={permissionMode}
            onPermissionModeChange={onPermissionModeChange}
            creditUsed={creditUsed}
            creditCap={creditCap}
            planName={planName}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          />

          {error && (
            <div className="px-5 pt-3">
              <div className="bg-error/10 text-error rounded-large-element p-3 text-sm font-mono" role="alert">
                {error}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {!hasMessages ? (
              <ChatEmpty onSuggestionClick={handleSuggestion} />
            ) : (
              <>
                {messages.map((msg, i) => (
                  <ChatMessage key={i} role={msg.role} content={msg.content} />
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

                {snapshotEvents.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {snapshotEvents.map((s, i) => (
                      <Pill key={i} variant="success">
                        <Camera size={10} />
                        Restore point created
                      </Pill>
                    ))}
                  </div>
                )}

                <AgentTrace events={events} />

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

      {sidebarOpen && (
        <div className="hidden lg:block">
          <ConversationSidebar
            conversations={conversations}
            activeId={activeConvId}
            onSelect={onSelectConversation}
            onNewChat={onNewChat}
          />
        </div>
      )}
    </div>
  );
}

HelpChatLayout.propTypes = {
  messages: PropTypes.array,
  events: PropTypes.array,
  isStreaming: PropTypes.bool,
  permissionMode: PropTypes.string,
  onPermissionModeChange: PropTypes.func,
  model: PropTypes.string,
  onModelChange: PropTypes.func,
  modelOptions: PropTypes.array,
  creditUsed: PropTypes.number,
  creditCap: PropTypes.number,
  planName: PropTypes.string,
  conversations: PropTypes.array,
  activeConvId: PropTypes.string,
  onSelectConversation: PropTypes.func,
  onNewChat: PropTypes.func,
  onSend: PropTypes.func,
  onStop: PropTypes.func,
  pendingPermissions: PropTypes.array,
  onAllowPermission: PropTypes.func,
  onDenyPermission: PropTypes.func,
  error: PropTypes.string,
};

export default HelpChatLayout;
