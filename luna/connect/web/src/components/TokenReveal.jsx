import { useState } from "react";
import { adminApi } from "../context/AdminAuthContext.jsx";
import { Button } from "./ui/button.jsx";
import { Input } from "./ui/input.jsx";

export default function TokenReveal({ hint, deviceId = null, compact = false }) {
  const [details, setDetails] = useState(null);
  const [prompting, setPrompting] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [revealError, setRevealError] = useState("");
  const [copied, setCopied] = useState(false);

  async function reveal(event) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setRevealError("");
    setPassword("");
    try {
      const data = await adminApi(
        `/admin/device-codes/${encodeURIComponent(deviceId)}/reveal`,
        { method: "POST", body: JSON.stringify({ password }), cache: "no-store" },
      );
      if (data.device_uid && data.verification_code) {
        setDetails({ deviceUid: data.device_uid, verificationCode: data.verification_code });
        setPrompting(false);
      } else {
        setRevealError(data.message || "Pairing details are not available for this Luna.");
      }
    } catch (err) {
      setRevealError(err.message || "Could not show the pairing details.");
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
      /* clipboard may be blocked; the details are still on screen */
    }
  }

  const shown = Boolean(details);
  return (
    <div className={compact ? "space-y-1" : "space-y-1 min-w-[12rem]"} data-testid="token-reveal">
      <p className={`font-mono break-all ${compact ? "text-xs" : "text-sm"}`}>
        {details?.deviceUid || hint || "None"}
      </p>
      {details ? (
        <p className="font-mono break-all text-xs">
          Verification code <span className="text-foreground">{details.verificationCode}</span>
        </p>
      ) : null}
      {deviceId && !prompting && (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={() => {
            if (shown) {
              setDetails(null);
              setCopied(false);
            } else {
              setPrompting(true);
            }
          }}>
            {shown ? "Hide pairing details" : "Show pairing details"}
          </Button>
          {shown && (
            <Button size="sm" variant="ghost" onClick={copy}>
              {copied ? "Copied" : "Copy details"}
            </Button>
          )}
        </div>
      )}
      {prompting && (
        <form className="space-y-1" onSubmit={reveal} aria-busy={busy}>
          <label className="block text-sm">
            Staff password
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={busy}
              autoFocus
            />
          </label>
          <div className="flex flex-wrap gap-1">
            <Button type="submit" size="sm" loading={busy}>Reveal details</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => {
              setPassword("");
              setRevealError("");
              setPrompting(false);
            }}>
              Cancel
            </Button>
          </div>
          {revealError && <p className="text-xs" role="alert">{revealError}</p>}
        </form>
      )}
    </div>
  );
}
