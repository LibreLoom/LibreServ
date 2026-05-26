import { Send, StopCircle } from "lucide-react";
import PropTypes from "prop-types";
import Button from "../ui/Button.jsx";

function ChatInputBar({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming = false,
  disabled = false,
}) {
  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend?.();
    }
  }

  return (
    <div className="border-t border-primary/10 p-3">
      <div className="flex gap-2 items-end">
        <textarea
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you need help with..."
          disabled={disabled || isStreaming}
          rows={1}
          className="flex-1 bg-primary text-secondary rounded-large-element px-4 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-secondary/40"
          aria-label="Type your message"
        />
        {isStreaming ? (
          <Button variant="danger" size="md" onClick={onStop} aria-label="Stop the assistant">
            <StopCircle size={16} />
          </Button>
        ) : (
          <Button
            variant="primary"
            size="md"
            onClick={onSend}
            disabled={disabled || !value?.trim()}
            aria-label="Send message"
          >
            <Send size={16} />
          </Button>
        )}
      </div>
    </div>
  );
}

ChatInputBar.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func,
  onSend: PropTypes.func,
  onStop: PropTypes.func,
  isStreaming: PropTypes.bool,
  disabled: PropTypes.bool,
};

export default ChatInputBar;
