import { useState } from "react";
import { Button } from "./ui/button.jsx";

/**
 * Shows a short token hint by default. The full token is only fetched when the
 * admin asks: pass `onReveal` (async, returns the code) for rows whose token is
 * stored sealed — the list response itself never contains it.
 */
export default function TokenReveal({ hint, code, onReveal = null, label = "token", compact = false }) {
  const [revealed, setRevealed] = useState(false);
  const [fetched, setFetched] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealError, setRevealError] = useState("");
  const [copied, setCopied] = useState(false);
  const full = code || fetched;
  const display = revealed && full ? full : hint || "—";
  const canReveal = Boolean(full) || Boolean(onReveal);
  const showNoun = label === "token" ? "token" : "code";

  async function toggle() {
    if (!revealed && !full && onReveal) {
      setBusy(true);
      setRevealError("");
      try {
        const c = await onReveal();
        if (c) {
          setFetched(c);
          setRevealed(true);
        } else {
          setRevealError("No full token is stored for this row — only the hint.");
        }
      } catch (err) {
        setRevealError(err.message || "Could not reveal the token.");
      } finally {
        setBusy(false);
      }
      return;
    }
    setRevealed((v) => !v);
  }

  async function copy() {
    if (!full) return;
    try {
      await navigator.clipboard.writeText(full);
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
            loading={busy}
            onClick={toggle}
            aria-pressed={revealed}
          >
            {revealed ? `Hide full ${showNoun}` : `Show full ${showNoun}`}
          </Button>
        )}
        {revealed && full && (
          <Button size="sm" variant="ghost" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
        )}
      </div>
      {revealError && <p className="text-xs text-error">{revealError}</p>}
    </div>
  );
}
