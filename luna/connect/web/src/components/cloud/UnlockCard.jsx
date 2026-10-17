import { useId, useState } from "react";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import { Button } from "../ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.jsx";
import { Label } from "../ui/label.jsx";
import { CONNECT_HOST, PHISHING_LINE } from "../../lib/connectHost.js";

/**
 * Recovery phrase prompt. onUnlock(words) resolves when it worked, or rejects with an Error whose message is shown.
 * @param {{ title?: string, description?: string, onUnlock: (words: string) => Promise<void>, testId?: string }} props
 */
export function UnlockCard({ title = "Open your cloud backups", description, onUnlock, testId = "cloud-unlock" }) {
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
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <p className="text-sm text-muted-foreground leading-relaxed">{description}</p> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={fieldId}>Recovery phrase</Label>
          <textarea
            id={fieldId}
            rows={3}
            value={words}
            onChange={(e) => setWords(e.target.value)}
            placeholder="12 words, with spaces between them"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="flex w-full rounded-large-element border border-input bg-background px-4 py-2 font-mono text-sm text-foreground outline-none transition-colors focus-visible:border-ring"
          />
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {phishingBefore}
          <InlinePill>{CONNECT_HOST}</InlinePill>
          {phishingAfter}
        </p>
        {error ? <p role="alert" className="text-sm text-error">{error}</p> : null}
        <Button variant="default" loading={busy} onClick={submit}>
          Open backups
        </Button>
      </CardContent>
    </Card>
  );
}
