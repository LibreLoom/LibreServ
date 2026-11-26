import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { formatDeviceToken } from "../lib/devicePairing.js";
import { Button } from "./ui/button.jsx";

/**
 * Show a freshly minted device token once. Luna Connect keeps only a hash, so
 * there is no way to show it again: copy it or print it before leaving.
 */
export default function TokenReveal({ token }) {
  const [copied, setCopied] = useState(false);
  const shown = formatDeviceToken(token);

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be blocked; the token is still on screen */
    }
  }

  return (
    <div className="space-y-2 rounded-large-element bg-muted border border-border p-4" data-testid="token-reveal">
      <p className="text-sm text-muted-foreground">Device token</p>
      <p className="font-mono text-xl tracking-widest break-all">{shown}</p>
      <p className="text-sm text-muted-foreground">Luna Connect cannot show this token again. Copy or print it now.</p>
      <Button type="button" size="sm" variant="outline" onClick={copy}>
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? "Copied" : "Copy device token"}
      </Button>
    </div>
  );
}
