import { useState } from "react";
import { Save, ArrowRight } from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { useToast } from "../context/ToastContext";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import FormInput from "../components/common/forms/FormInput";
import Button from "../components/ui/Button";
import Pill from "../components/common/Pill";
import ApiTokensCard from "../components/profile/ApiTokensCard";
import MfaCard from "../components/profile/MfaCard";

/**
 * Self-service account page for non-admin users. They can view their profile,
 * update their own email, and change their password — the only profile actions
 * the backend permits for a regular user.
 */
export default function MyProfile() {
  const { me, request } = useAuth();
  const { addToast } = useToast();

  const [email, setEmail] = useState(me?.email || "");
  const [emailError, setEmailError] = useState("");
  const [emailSaving, setEmailSaving] = useState(false);

  const [pw, setPw] = useState({ old: "", new: "" });
  const [pwErrors, setPwErrors] = useState(
    /** @type {Record<string, string>} */ ({}),
  );
  const [pwSaving, setPwSaving] = useState(false);

  const emailDirty = (me?.email || "") !== email;

  const handleSaveEmail = async (e) => {
    e.preventDefault();
    setEmailSaving(true);
    setEmailError("");
    try {
      await request("/auth/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      addToast({ type: "success", message: "Email updated" });
    } catch (err) {
      const status = err.cause?.status;
      if (status === 409) setEmailError("Email is already in use");
      else if (status === 400)
        setEmailError(err.message || "Please enter a valid email");
      else setEmailError(err.message || "Couldn't update email. Please try again.");
    } finally {
      setEmailSaving(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    /** @type {Record<string, string>} */
    const errs = {};
    if (!pw.old) errs.old = "Current password is required";
    if (pw.new.length < 12) errs.new = "Password must be at least 12 characters";
    else if (!/[a-zA-Z]/.test(pw.new) || !/[0-9]/.test(pw.new))
      errs.new = "Password must include letters and numbers";
    if (Object.keys(errs).length) {
      setPwErrors(errs);
      return;
    }

    setPwSaving(true);
    setPwErrors({});
    try {
      await request("/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_password: pw.old, new_password: pw.new }),
      });
      addToast({ type: "success", message: "Password changed" });
      setPw({ old: "", new: "" });
    } catch (err) {
      const status = err.cause?.status;
      if (status === 401) setPwErrors({ old: "Current password is incorrect" });
      else if (status === 400) {
        const m = (err.message || "").toLowerCase();
        if (m.includes("current") || m.includes("old"))
          setPwErrors({ old: err.message });
        else
          setPwErrors({ new: err.message || "Password does not meet requirements" });
      } else
        setPwErrors({
          form: err.message || "Couldn't change password. Please try again.",
        });
    } finally {
      setPwSaving(false);
    }
  };

  return (
    <Page title="My Account" titleId="profile-title" headerClassName="mb-6" data-slot="my-profile">
      <div className="max-w-lg mx-auto space-y-6">
        <Card title="Profile">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-primary text-sm">Username</span>
              <span className="font-medium text-primary">{me?.username}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-primary text-sm">Role</span>
              <Pill variant={me?.role === "admin" ? "accent" : "default"}>
                {me?.role}
              </Pill>
            </div>

            <form onSubmit={handleSaveEmail} className="space-y-3">
              <FormInput
                label="Email (optional)"
                name="email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setEmailError("");
                }}
                placeholder="e.g. you@example.com"
                error={emailError}
                icon="email"
                disabled={emailSaving}
              />
              <Button
                type="submit"
                variant="primary"
                loading={emailSaving}
                disabled={!emailDirty || emailSaving}
                className="w-full"
              >
                <Save size={16} aria-hidden="true" />
                Save Email
              </Button>
            </form>
          </div>
        </Card>

        <Card title="Change Password">
          <form onSubmit={handleChangePassword} className="space-y-3">
            <FormInput
              label="Current Password"
              name="old_password"
              type="password"
              value={pw.old}
              onChange={(e) => {
                setPw((p) => ({ ...p, old: e.target.value }));
                setPwErrors((x) => ({ ...x, old: "" }));
              }}
              placeholder="Enter current password"
              error={pwErrors.old}
              icon="password"
              required
              disabled={pwSaving}
            />
            <FormInput
              label="New Password"
              name="new_password"
              type="password"
              value={pw.new}
              onChange={(e) => {
                setPw((p) => ({ ...p, new: e.target.value }));
                setPwErrors((x) => ({ ...x, new: "" }));
              }}
              placeholder="Minimum 12 characters (letters and numbers)"
              error={pwErrors.new}
              icon="password"
              required
              disabled={pwSaving}
            />
            {pwErrors.form && (
              <div className="bg-error/10 border border-error/30 rounded-pill px-4 py-2 text-error text-sm text-center">
                {pwErrors.form}
              </div>
            )}
            <Button
              type="submit"
              variant="primary"
              loading={pwSaving}
              className="w-full"
            >
              Change Password
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </form>
        </Card>
        <MfaCard />
        <ApiTokensCard />
      </div>
    </Page>
  );
}
