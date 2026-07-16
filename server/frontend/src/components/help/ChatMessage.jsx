import { cn } from "@/lib/utils";
import PropTypes from "prop-types";
import { Bot, User } from "lucide-react";

function ChatMessage({ role, content }) {
  const isUser = role === "user";

  return (
    <div className={cn("flex gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div className="shrink-0 mt-1 w-6 h-6 rounded-pill bg-primary text-secondary flex items-center justify-center">
          <Bot size={11} strokeWidth={2.5} />
        </div>
      )}
      <div
        className={cn("rounded-large-element px-3.5 py-2.5 text-sm leading-relaxed max-w-[80%]", isUser ? "bg-primary text-secondary" : "bg-primary/5 text-primary border border-primary/10")}
      >
        {content}
      </div>
      {isUser && (
        <div className="shrink-0 mt-1 w-6 h-6 rounded-pill bg-accent text-primary flex items-center justify-center">
          <User size={11} strokeWidth={2.5} />
        </div>
      )}
    </div>
  );
}

ChatMessage.propTypes = {
  role: PropTypes.oneOf(["user", "assistant"]).isRequired,
  content: PropTypes.string.isRequired,
};

export default ChatMessage;
