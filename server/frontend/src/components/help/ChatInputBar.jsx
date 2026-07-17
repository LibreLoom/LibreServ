import { useRef, useLayoutEffect } from "react";
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
  const textareaRef = useRef(null);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend?.();
    }
  }

  return (
    <div data-slot="help-chat-input" className="border-t border-primary/10 p-4">
      <div className="flex gap-3 items-end">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe your issue..."
          disabled={disabled || isStreaming}
          rows={1}
          className="flex-1 bg-primary text-secondary rounded-large-element px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-accent placeholder:text-secondary/40 min-h-[44px] max-h-[200px]"
          aria-label="Describe your issue"
        />
        {isStreaming ? (
          <Button
            variant="accent"
            size="md"
            onClick={onStop}
            aria-label="Stop the assistant"
            className="shrink-0"
          >
            <StopCircle size={18} />
          </Button>
        ) : (
          <Button
            variant="primary"
            size="md"
            onClick={onSend}
            disabled={disabled || !value?.trim()}
            aria-label="Send message"
            className="shrink-0"
          >
            <Send size={18} />
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
