import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import CollapsibleSection from "@libreloom/ui/components/common/CollapsibleSection.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import InlineError from "@libreloom/ui/components/common/InlineError.jsx";
import Callout from "@libreloom/ui/components/common/Callout.jsx";
import Toggle from "@libreloom/ui/components/common/Toggle.jsx";
import FormInput from "../components/common/forms/FormInput";
import usePageTitle from "../hooks/usePageTitle.js";
import { MIN_PASSWORD_LENGTH, passwordPolicyError } from "@libreloom/ui/lib/passwordPolicy.js";
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
    const passwordError = passwordPolicyError(password, { lengthUnit: "utf8-bytes" });
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
      <div className="mx-auto w-full max-w-xl">
        <Card surface="secondary" padding={false}>
          <div className="p-5 sm:p-7">
            <span className="block text-center text-primary font-mono text-2xl">Luna</span>
            <div className="my-5 h-px bg-accent" />
            <h1 className="text-center text-primary font-mono text-xl font-normal">Create a password recovery file</h1>
            <p className="mx-auto mt-2 max-w-md text-center text-primary text-sm">
              Put this file on a USB drive to set a new password when Luna starts. Your password never leaves this device.
            </p>

            <form onSubmit={handleSubmit} className="mt-6 space-y-6" noValidate>
              <section className="space-y-4">
                <div>
                  <h2 className="font-mono text-base font-normal text-primary">Who is it for?</h2>
                  <p className="mt-1 text-primary text-sm">
                    The file changes the password for the account or group you choose.
                  </p>
                </div>
                <Dropdown
                  options={SELECTORS.map(([value, label]) => ({ value, label }))}
                  value={selectorType}
                  onChange={(value) => {
                    haptic("selection");
                    clearFeedback();
                    setSelectorType(value);
                  }}
                  fullWidth
                  size="form"
                  bg="primary"
                  aria-label="Account to recover"
                />
                {(selectorType === "u" || selectorType === "n" || selectorType === "f") && (
                  <div>
                    <FormInput
                      label="Username"
                      name="recovery-username"
                      value={username}
                      onChange={(e) => { clearFeedback(); setUsername(e.target.value); }}
                      autoComplete="username"
                      required
                      error={errorField === "username" ? error : undefined}
                    />
                    <p className="text-primary text-sm">
                      {selectorType === "u" && "Use the existing Luna username."}
                      {selectorType === "n" && "Luna creates this Admin account when it starts with the recovery drive."}
                      {selectorType === "f" && "Luna changes the password if this account exists. Otherwise, it creates a new Admin account."}
                    </p>
                  </div>
                )}
              </section>

              <section className="space-y-3 border-t border-primary/10 pt-5">
                <div>
                  <h2 className="font-mono text-base font-normal text-primary">Device token</h2>
                  <p className="mt-1 text-primary text-sm">
                    A device token ties the file to this Luna. It is printed on the recovery card that came with Luna.
                  </p>
                </div>
                <Toggle
                  surface="secondary"
                  checked={hasToken}
                  onChange={(checked) => {
                    haptic("selection");
                    clearFeedback();
                    setHasToken(checked);
                  }}
                  label="This Luna has a device token"
                  description={hasToken ? undefined : "Leave this off if your Luna has no device token."}
                />
                {hasToken && (
                  <FormInput
                    label="Device token"
                    name="device-token"
                    value={token}
                    onChange={(e) => { clearFeedback(); setToken(e.target.value); }}
                    autoComplete="off"
                    required
                    hint="Enter the token exactly as it appears on the recovery card."
                    error={errorField === "device-token" ? error : undefined}
                  />
                )}
                <p className="text-primary text-sm">
                  File name: {hasToken && !token.trim()
                    ? "Enter your device token to see the file name."
                    : <InlinePill>{filename}</InlinePill>}
                </p>
              </section>

              <section className="space-y-3 border-t border-primary/10 pt-5">
                <div>
                  <h2 className="font-mono text-base font-normal text-primary">Set a new password</h2>
                  <p className="mt-1 text-primary text-sm">
                    Use at least 12 characters, with an English letter and a number. Accented letters and some symbols count as more than one.
                  </p>
                </div>
                <FormInput
                  label="New password"
                  name="recovery-password"
                  type="password"
                  value={password}
                  onChange={(e) => { clearFeedback(); setPassword(e.target.value); }}
                  autoComplete="new-password"
                  required
                  error={errorField === "password" ? error : undefined}
                />
                <FormInput
                  label="Confirm new password"
                  name="recovery-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => { clearFeedback(); setConfirm(e.target.value); }}
                  autoComplete="new-password"
                  required
                  error={errorField === "confirm" ? error : undefined}
                />
                <p className="text-primary text-sm">The selected accounts will be signed out on their other devices.</p>
              </section>

              {error && <InlineError>{error}</InlineError>}
              {downloaded && (
                <Callout tone="success">
                  Your recovery file downloaded as <InlinePill>{filename}</InlinePill>.
                </Callout>
              )}
              <Button type="submit" variant="primary" surface="secondary" fullWidth>Download recovery file</Button>
            </form>

            <CollapsibleSection title="How to use the recovery file" pill className="mt-6">
              <ol className="list-decimal space-y-2 pl-5 text-sm text-primary">
                <li>Use an otherwise-empty USB flash drive that has never been added to a Luna.</li>
                <li>Put the downloaded recovery file directly on the drive, not inside a folder. Keep other files off it.</li>
                <li>Turn Luna off, plug in the drive, then turn Luna on. Luna checks the file once during startup, before it accepts connections.</li>
                <li>After recovery, remove the drive. Luna tries to rename the file so it will not reset the password again on the next startup.</li>
              </ol>
              <p className="mt-3 text-sm text-primary">A recovery file does not change the password while Luna is already running. It works only during startup.</p>
            </CollapsibleSection>
            <p className="mt-6 text-center text-sm"><Link className="text-primary underline decoration-accent underline-offset-4" to="/login">Back to sign in</Link></p>
          </div>
        </Card>
      </div>
    </main>
  );
}
