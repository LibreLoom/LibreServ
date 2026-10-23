import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import FormInput from "../components/common/forms/FormInput";
import usePageTitle from "../hooks/usePageTitle.js";
import { MIN_PASSWORD_LENGTH } from "@libreloom/ui/lib/passwordPolicy.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { isValidUsername, USERNAME_POLICY_HINT } from "../lib/usernamePolicy.js";

const SELECTORS = [
  ["g-admin", "All Admin accounts"],
  ["g-member", "All Member accounts"],
  ["g-all", "All accounts"],
  ["u", "One existing account"],
  ["n", "Create a new Admin account"],
  ["f", "Use an account or create it if missing"],
];

function normalizedToken(value) {
  return value.trim().replace(/[-_ ]/g, "").toUpperCase().replace(/[ILO]/g, (char) => ({ I: "1", L: "1", O: "0" })[char]);
}

function recoveryPasswordPolicyError(password) {
  if (!password) return "Enter a password.";
  if (new TextEncoder().encode(password).length < MIN_PASSWORD_LENGTH) {
    return "Passwords need at least 12 characters. Accented letters and some symbols count as more than one.";
  }
  if (!/[a-z]/i.test(password) || !/[0-9]/.test(password)) {
    return "Passwords need an English letter and a number.";
  }
  return null;
}

export default function RecoveryWizardPage() {
  usePageTitle("Password recovery file");
  const [hasToken, setHasToken] = useState(true);
  const [token, setToken] = useState("");
  const [selectorType, setSelectorType] = useState("g-admin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState("");
  const [downloaded, setDownloaded] = useState(false);

  const selector = selectorType === "u" || selectorType === "n" || selectorType === "f"
    ? `${selectorType}-${username.trim().toLowerCase()}`
    : selectorType;
  const filename = useMemo(() => hasToken && token.trim()
    ? `luna-recover-${normalizedToken(token).toLowerCase()}.luna`
    : "luna-recover.luna", [hasToken, token]);

  function clearFeedback() {
    setError("");
    setErrorField("");
    setDownloaded(false);
  }

  function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setErrorField("");
    setDownloaded(false);
    const deviceToken = normalizedToken(token);
    if (hasToken && !/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16,32}$/.test(deviceToken)) {
      setError("Enter the 16 to 32 character device token from your Luna recovery card, or choose that this Luna has no device token.");
      setErrorField("device-token");
      return;
    }
    if ((selectorType === "u" || selectorType === "n" || selectorType === "f") && !isValidUsername(username)) {
      setError(USERNAME_POLICY_HINT);
      setErrorField("username");
      return;
    }
    const passwordError = recoveryPasswordPolicyError(password);
    if (passwordError) { setError(passwordError); setErrorField("password"); return; }
    if (password !== confirm) { setError("The passwords do not match."); setErrorField("confirm"); return; }

    let url;
    let link;
    try {
      const contents = JSON.stringify({ user: selector, password });
      const blob = new Blob([contents], { type: "application/json" });
      url = URL.createObjectURL(blob);
      link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      // Firefox starts reading the file after click returns, so keep the blob
      // URL alive long enough for the download to begin.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      link?.remove();
      if (url) URL.revokeObjectURL(url);
      haptic("error");
      setError("The recovery file could not be created. Try again.");
      return;
    }
    setDownloaded(true);
  }

  return (
    <main data-slot="recovery-wizard" className="min-h-screen surface-primary px-4 py-8" id="main-content" tabIndex={-1}>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <div className="mx-auto w-full max-w-2xl">
        <Card surface="secondary" padding={false}>
          <div className="p-6 sm:p-8">
            <span className="block text-center text-primary font-mono text-2xl">Luna</span>
            <div className="my-5 h-px bg-accent" />
            <h1 className="text-center text-primary font-mono text-xl font-normal">Create a password recovery file</h1>
            <p className="mt-3 text-primary">This page creates a recovery file on this device. It does not send your password to Luna or another service.</p>
            <p className="mt-2 text-sm">The file contains your new password in readable text. Keep the drive private until Luna has started again.</p>
            <form onSubmit={handleSubmit} className="mt-6" noValidate>
              <section className="rounded-large-element surface-primary p-4 sm:p-5">
                <h2 className="font-mono text-lg font-normal">Choose the account</h2>
                <p className="mt-1 text-secondary text-sm">The recovery file targets the account or group you choose.</p>
                <p className="mt-1 text-secondary text-sm">Group choices need at least one matching account. Creating a new Admin account requires a username Luna does not already use.</p>
                <fieldset className="mt-4 space-y-3">
                  <legend className="sr-only">Account to recover</legend>
                  {SELECTORS.map(([value, label]) => (
                    <label key={value} className="flex cursor-pointer items-center gap-3 rounded-large-element surface-secondary p-3 text-primary">
                      <input type="radio" name="selector" value={value} checked={selectorType === value} onChange={() => { haptic("selection"); clearFeedback(); setSelectorType(value); }} />
                      <span>{label}</span>
                    </label>
                  ))}
                </fieldset>
                {(selectorType === "u" || selectorType === "n" || selectorType === "f") && (
                  <div className="mt-4">
                    <FormInput label="Username" name="recovery-username" value={username} onChange={(e) => { clearFeedback(); setUsername(e.target.value); }} autoComplete="username" surface="primary" required error={errorField === "username" ? error : undefined} />
                    <p className="text-secondary text-sm">
                      {selectorType === "u" && "Use the existing Luna username."}
                      {selectorType === "n" && "Luna creates this Admin account when it starts with the recovery drive."}
                      {selectorType === "f" && "Luna changes the password if this account exists. Otherwise, it creates a new Admin account."}
                    </p>
                  </div>
                )}
              </section>

              <section className="mt-4 rounded-large-element surface-primary p-4 sm:p-5">
                <h2 className="font-mono text-lg font-normal">Device token</h2>
                <p className="mt-1 text-secondary text-sm">A device token ties this file to your Luna. Find it on the printed recovery card.</p>
                <label className="mt-4 flex items-center gap-3">
                  <input type="checkbox" checked={hasToken} onChange={(e) => { haptic("selection"); clearFeedback(); setHasToken(e.target.checked); }} />
                  This Luna has a device token
                </label>
                {!hasToken && <p className="mt-2 text-secondary text-sm">Leave this unchecked if your Luna has no device token.</p>}
                {hasToken && <div className="mt-4"><FormInput label="Device token" name="device-token" value={token} onChange={(e) => { clearFeedback(); setToken(e.target.value); }} autoComplete="off" surface="primary" required hint="Enter the token exactly as it appears on the recovery card." error={errorField === "device-token" ? error : undefined} /></div>}
                <p className="mt-3 text-secondary text-sm">
                  File name: {hasToken && !token.trim()
                    ? "Enter your device token to see the file name."
                    : <InlinePill>{filename}</InlinePill>}
                </p>
              </section>

              <section className="mt-4 rounded-large-element surface-primary p-4 sm:p-5">
                <h2 className="font-mono text-lg font-normal">Set a new password</h2>
                <p className="mt-1 text-secondary text-sm">Use at least 12 characters, with an English letter and a number. Accented letters and some symbols count as more than one.</p>
                <div className="mt-4">
                  <FormInput label="New password" name="recovery-password" type="password" value={password} onChange={(e) => { clearFeedback(); setPassword(e.target.value); }} autoComplete="new-password" surface="primary" required error={errorField === "password" ? error : undefined} />
                  <FormInput label="Confirm new password" name="recovery-confirm" type="password" value={confirm} onChange={(e) => { clearFeedback(); setConfirm(e.target.value); }} autoComplete="new-password" surface="primary" required error={errorField === "confirm" ? error : undefined} />
                </div>
                <p className="text-secondary text-sm">The selected accounts will be signed out on their other devices.</p>
              </section>

              {error && <p className="mt-4 rounded-large-element bg-error/20 border border-error/30 p-3 text-primary" role="alert">{error}</p>}
              {downloaded && <div className="mt-4 rounded-large-element bg-success/20 border border-success/30 p-3 text-primary" role="status"><p>Your recovery file downloaded as <InlinePill>{filename}</InlinePill>.</p></div>}
              <Button type="submit" variant="primary" surface="secondary" fullWidth className="mt-5">Download recovery file</Button>
            </form>

            <section className="mt-6 border-t border-secondary/30 pt-5">
              <h2 className="text-primary font-mono text-lg font-normal">Use a dedicated USB flash drive</h2>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-primary">
                <li>Use an otherwise-empty USB flash drive that has never been added to a Luna.</li>
                <li>Put the downloaded recovery file directly on the drive, not inside a folder. Keep other files off it.</li>
                <li>Turn Luna off, plug in the drive, then turn Luna on. Luna checks the file once during startup, before it accepts connections.</li>
                <li>After recovery, remove the drive. Luna tries to rename the file so it will not reset the password again on the next startup.</li>
              </ol>
              <p className="mt-3 text-sm">A recovery file does not change the password while Luna is already running. It works only during startup.</p>
            </section>
            <p className="mt-6 text-center text-sm"><Link className="text-primary underline decoration-accent underline-offset-4" to="/login">Back to sign in</Link></p>
          </div>
        </Card>
      </div>
    </main>
  );
}
