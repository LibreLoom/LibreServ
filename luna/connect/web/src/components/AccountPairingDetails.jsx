import { useState } from "react";
import { AlertCircle, Check, Copy } from "lucide-react";

import { api } from "../api.js";
import { formatDeviceUid } from "../lib/devicePairing.js";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";

/** Account-side pairing details. The reusable code is shown only after password step-up. */
export default function AccountPairingDetails({ deviceId }) {
  const [details, setDetails] = useState(null);
  const [prompting, setPrompting] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function reveal(event) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError("");
    setPassword("");
    try {
      const data = await api(`/api/v1/account/devices/${encodeURIComponent(deviceId)}/code`, {
        method: "POST",
        body: JSON.stringify({ password }),
        cache: "no-store",
      });
      if (!data.device_uid || !data.verification_code) {
        throw new Error("Luna Connect did not return the pairing details. Try again.");
      }
      setDetails({
        deviceUid: formatDeviceUid(data.device_uid),
        verificationCode: String(data.verification_code).trim().toUpperCase(),
      });
      setPrompting(false);
    } catch (err) {
      setError(err.message || "Could not show the pairing details. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${details.deviceUid.replace(/-/g, "")} ${details.verificationCode}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy. Select the pairing details and copy them yourself.");
    }
  }

  function hide() {
    setDetails(null);
    setCopied(false);
    setError("");
  }

  return (
    <div className="space-y-3" data-testid="account-pairing-details">
      {details ? (
        <div className="rounded-large-element bg-muted border border-border px-4 py-4 space-y-3">
          <div>
            <p className="text-sm text-muted-foreground">Device ID</p>
            <p className="font-mono text-sm break-all">{details.deviceUid}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Verification code</p>
            <p className="font-mono text-sm">{details.verificationCode}</p>
          </div>
          <p className="text-sm text-muted-foreground">
            If Luna&apos;s Verification code was removed, enter both values in Settings → Luna Connect → Device token.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={copy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy pairing details"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={hide}>
              Hide pairing details
            </Button>
          </div>
        </div>
      ) : null}

      {!details && !prompting ? (
        <Button type="button" variant="outline" size="sm" onClick={() => setPrompting(true)}>
          Show pairing details
        </Button>
      ) : null}

      {prompting ? (
        <form className="rounded-large-element bg-muted border border-border px-4 py-4 space-y-3" onSubmit={reveal}>
          <label htmlFor="luna-pairing-password" className="block text-sm">
            Luna Connect password
          </label>
          <Input
            id="luna-pairing-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            disabled={busy}
            autoFocus
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={busy} disabled={!password}>
              Reveal pairing details
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setPassword("");
                setError("");
                setPrompting(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {error ? (
        <div className="rounded-large-element border border-error/30 bg-error/10 px-3 py-3 flex items-start gap-2" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-error" aria-hidden="true" />
          <p className="text-sm text-foreground">{error}</p>
        </div>
      ) : null}
    </div>
  );
}
