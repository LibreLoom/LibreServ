import { useEffect, useId, useState } from "react";
import { Button } from "../ui/button.jsx";
import { Input } from "../ui/input.jsx";
import { Label } from "../ui/label.jsx";
import { createShareLink, shareUrl } from "../../lib/shareLinks.js";

/**
 * "Share link" for one person's backups (scope kind "user") or one backup (kind "backup").
 * Shows the new link in an inline panel. The token is kept only while the panel is open.
 * @param {{ lunaId: string, scope: { kind: "user" | "backup", value: string }, label: string, onCreated?: () => void }} props
 */
export function ShareLinkButton({ lunaId, scope, label, onCreated }) {
  const fieldId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function create() {
    setError("");
    setBusy(true);
    try {
      const res = await createShareLink(lunaId, scope);
      setLink({ url: shareUrl(res.token) });
      onCreated?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    setError("");
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setError("Could not copy the link. Select it and copy it yourself.");
    }
  }

  function done() {
    setLink(null);
    setCopied(false);
    setError("");
  }

  const sentence =
    scope.kind === "user"
      ? `Anyone with this link and ${label}'s recovery phrase can download these backups for 7 days. The link alone opens nothing.`
      : `Anyone with this link and the recovery phrase of someone who has ${label} can download it for 7 days. The link alone opens nothing.`;

  return (
    <div className="space-y-3 min-w-0">
      {link ? null : (
        <Button type="button" variant="outline" size="sm" loading={busy} onClick={create}>
          Share link
        </Button>
      )}
      {link ? (
        <div className="rounded-large-element border border-border px-4 py-4 space-y-3 w-full" data-testid="share-link-panel">
          <div className="space-y-2">
            <Label htmlFor={fieldId}>Share link</Label>
            <Input id={fieldId} readOnly value={link.url} onFocus={(e) => e.target.select()} />
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">{sentence}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={done}>
              Done
            </Button>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            This link is shown only once. Copy it now. After you click Done, you can't see it again.
          </p>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-error">{error}</p> : null}
    </div>
  );
}
