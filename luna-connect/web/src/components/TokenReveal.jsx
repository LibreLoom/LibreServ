import { useState } from "react";
import { Button } from "./ui/button.jsx";

/**
 * Shows a short token hint by default; optional Show full token when `code` is present.
 * Used in admin lists where many tokens look alike until the full code is revealed.
 */
export default function TokenReveal({ hint, code, label = "token", compact = false }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const display = revealed && code ? code : hint || "—";
  const canReveal = Boolean(code);
  const showNoun = label === "token" ? "token" : "code";

  async function copy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be blocked; full value is still on screen when revealed */
    }
  }

  return (
    <div className={compact ? "space-y-1" : "space-y-1 min-w-[12rem]"} data-testid="token-reveal">
      <p className={`font-mono break-all ${compact ? "text-xs" : "text-sm"}`}>{display}</p>
      <div className="flex flex-wrap gap-1">
        {canReveal && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRevealed((v) => !v)}
            aria-pressed={revealed}
          >
            {revealed ? `Hide full ${showNoun}` : `Show full ${showNoun}`}
          </Button>
        )}
        {revealed && code && (
          <Button size="sm" variant="ghost" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </div>
    </div>
  );
}
