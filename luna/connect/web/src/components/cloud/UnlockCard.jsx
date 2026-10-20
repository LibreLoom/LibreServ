import { useId, useState } from "react";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { Button } from "../ui/button.jsx";
import { Lock } from "lucide-react";
import { Label } from "../ui/label.jsx";
import { CONNECT_HOST, PHISHING_LINE } from "../../lib/connectHost.js";

/**
 * Recovery phrase prompt. onUnlock(words) resolves when it worked, or rejects with an Error whose message is shown.
 * @param {{ title?: string, description?: string, onUnlock: (words: string) => Promise<void>, testId?: string }} props
 */
export function UnlockCard({ title = "Your backups are locked", description, onUnlock, testId = "cloud-unlock" }) {
  const fieldId = useId();
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    setBusy(true);
    try {
      await onUnlock(words);
    } catch (err) {
      setError(err.message);
    } finally {
      setWords("");
      setBusy(false);
    }
  }

  const [phishingBefore, phishingAfter] = PHISHING_LINE.split(CONNECT_HOST);

  return (
    <div data-testid={testId} className="rounded-large-element bg-secondary text-secondary-foreground p-5 space-y-4">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-pill bg-card" aria-hidden="true">
          <Lock className="size-4" />
        </span>
        <div className="space-y-1">
          <h4 className="font-mono text-lg">{title}</h4>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {description || "Your backups are encrypted on Luna. One recovery phrase opens every backup you can access."}
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            The phrase stays in this browser. It is never sent to Luna Connect.
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor={fieldId}>Recovery phrase</Label>
        <textarea
          id={fieldId}
          rows={3}
          value={words}
          onChange={(e) => setWords(e.target.value)}
          placeholder="Your recovery words, with spaces between them"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="flex w-full resize-none rounded-large-element border border-transparent bg-card px-4 py-3 text-sm text-foreground outline-none transition-colors focus-visible:border-ring"
        />
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {phishingBefore}
        <InlinePill>{CONNECT_HOST}</InlinePill>
        {phishingAfter}
      </p>
      {error ? <p role="alert" className="text-sm text-error">{error}</p> : null}
      <Button variant="default" loading={busy} disabled={!words.trim()} onClick={submit}>
        Unlock backups
      </Button>
    </div>
  );
}
