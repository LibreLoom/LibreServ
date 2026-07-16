import { Bot } from "lucide-react";

function ChatStreamingIndicator() {
  return (
    <div data-slot="help-chat-streaming" className="flex gap-2 justify-start">
      <div className="shrink-0 mt-1 w-6 h-6 rounded-pill bg-primary text-secondary flex items-center justify-center">
        <Bot size={11} strokeWidth={2.5} />
      </div>
      <div className="bg-primary/5 text-primary border border-primary/10 rounded-large-element px-3.5 py-2.5 text-sm leading-relaxed">
        <span className="inline-flex gap-1" aria-label="Assistant is thinking">
          <span className="animate-bounce">.</span>
          <span className="animate-bounce [animation-delay:0.1s]">.</span>
          <span className="animate-bounce [animation-delay:0.2s]">.</span>
        </span>
      </div>
    </div>
  );
}

export default ChatStreamingIndicator;
