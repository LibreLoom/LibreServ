import { useState, useRef, useEffect } from "react";
import PropTypes from "prop-types";
import { Terminal, Copy, Check } from "lucide-react";
import { copyWithFeedback } from "../../utils/clipboard";

/**
 * @param {{ content: any, title?: any, maxHeight?: string }} _
 */
export default function ReadOnlyTerminal({ content, title, maxHeight = "300px" }) {
  const [copied, setCopied] = useState(false);
  const termRef = useRef(null);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [content]);

  const handleCopy = async () => {
    await copyWithFeedback(content, setCopied);
  };

  return (
    <div data-slot="agent-read-only-terminal" className="rounded-large-element overflow-hidden border border-primary/10">
      <div className="flex items-center justify-between px-3 py-1.5 bg-primary/5 border-b border-primary/10">
        <div className="flex items-center gap-1.5 text-xs text-primary/50 font-mono">
          <Terminal size={12} />
          {title || "Output"}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="text-xs text-primary/40 hover:text-primary/60 flex items-center gap-1 cursor-pointer"
          aria-label="Copy output"
        >
          {copied ? <Check size={10} className="text-success" /> : <Copy size={10} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        ref={termRef}
        className="px-3 py-2 text-xs text-primary/70 font-mono whitespace-pre-wrap break-all overflow-auto"
        style={{ maxHeight }}
      >
        {content || "No output yet."}
      </pre>
    </div>
  );
}

ReadOnlyTerminal.propTypes = {
  content: PropTypes.string,
  title: PropTypes.string,
  maxHeight: PropTypes.string,
};
