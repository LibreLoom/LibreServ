import { ShieldCheck } from "lucide-react";
import MfaCard from "../profile/MfaCard";

/**
 * Fullscreen gate shown to admins who have no MFA method enabled.
 *
 * "MFA is always-enabled for admins" — if an admin somehow reaches the app
 * without MFA (e.g. an account predates enforcement, or all methods were
 * removed), every app route is replaced by this blocker until they enroll at
 * least one method. It blocks UI usage, NOT sign-in — the admin is already
 * authenticated, they just can't use anything until two-factor is on.
 *
 * Gated in App.jsx RequireAuth on `me.role === "admin" && me.mfa_enabled === false`.
 * Reuses MfaCard for the actual enrollment; on success it reloads so /auth/me
 * is re-fetched and the blocker clears.
 */
export default function MfaBlocker() {
  return (
    <main
      className="fixed inset-0 grid place-items-center bg-primary px-4 overflow-auto"
      id="main-content"
      tabIndex={-1}
    >
      <div className="relative w-full max-w-lg overflow-auto bg-secondary text-primary rounded-large-element ring-2 ring-accent pop-in p-8 my-8">
        <span className="text-primary font-mono text-2xl block text-center">
          LibreServ
        </span>
        <div className="bg-accent p-px rounded-pill mt-6 mb-4"></div>
        <div className="flex items-center justify-center gap-2 text-primary mb-2">
          <ShieldCheck size={20} className="text-accent shrink-0" />
          <h1 className="text-xl font-normal font-mono">
            Turn on two-factor authentication
          </h1>
        </div>
        <p className="text-primary/80 text-sm text-center mb-6">
          As an admin, your account is a target. You need to enable at least one
          two-factor method before you can use LibreServ — you can change it
          later in My Account.
        </p>
        <MfaCard onMethodEnabled={() => window.location.reload()} />
      </div>
    </main>
  );
}