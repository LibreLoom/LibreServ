import { useAuth } from "../../hooks/useAuth";
import { ShieldCheck, LogOut } from "lucide-react";
import { MfaSetupWizard } from "../profile/MfaCard";
import { useAnimatedHeight } from "../../hooks/useAnimatedHeight";

/**
 * Fullscreen gate shown to admins who have no MFA method enabled.
 *
 * "MFA is always-enabled for admins" — if an admin somehow reaches the app
 * without MFA (e.g. an account predates enforcement, or all methods were
 * removed), every app route is replaced by this blocker until they enroll at
 * least one method. It blocks UI usage, NOT sign-in — the admin is already
 * authenticated, they just can't use anything until two-factor is on.
 *
 * Gated in App.jsx RequireAuth on `me.role === "admin" && !me.mfa_enabled`.
 * Reuses the setup wizard's guided flow (choose → backup codes → enroll); on
 * success it refreshes auth state so /auth/me is re-fetched and the blocker
 * clears. Sign-out stays available so nobody is trapped on this screen.
 */
export default function MfaBlocker() {
  const { refreshAuth, logout, me } = useAuth();
  // Wizard phases have very different heights (method picker vs. QR code vs.
  // backup codes) — animate the card between them instead of snapping.
  const { outerRef, innerRef } = useAnimatedHeight();
  return (
    <main
      data-slot="auth-mfa-blocker"
      className="fixed inset-0 grid place-items-center bg-primary px-4 overflow-auto"
      id="main-content"
      tabIndex={-1}
    >
      <div
        ref={outerRef}
        className="relative w-full max-w-lg overflow-hidden bg-secondary text-primary rounded-large-element ring-2 ring-accent pop-in my-8 transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
        style={{ transitionDuration: "var(--motion-duration-medium2)" }}
      >
        <div ref={innerRef} className="p-8">
          <span className="text-primary font-mono text-2xl block text-center">
            LibreServ
          </span>
          <div className="bg-accent p-px rounded-pill mt-6 mb-8"></div>

          {/* Hero — one icon, one heading, one sentence. The wizard below
              provides its own step-by-step structure. */}
          <div
            className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-full bg-accent/10 ring-1 ring-accent/30"
            aria-hidden="true"
          >
            <ShieldCheck size={28} className="text-accent" />
          </div>
          <h1 className="text-xl font-normal font-mono text-center text-balance">
            Turn on two-factor authentication
          </h1>
          <p className="text-primary/70 text-sm text-center text-balance max-w-sm mx-auto mt-3 mb-8">
            As an admin, your account is a target. Add a second sign-in check to
            start using LibreServ — it takes about a minute, and you can change
            it later in My Account.
          </p>

          <MfaSetupWizard onComplete={refreshAuth} onSessionExpired={refreshAuth} />

          {/* Escape hatch — a fullscreen gate must never trap the user. */}
          <div className="mt-8 pt-5 border-t border-primary/10 flex items-center justify-center gap-2 text-xs text-primary/50">
            {me?.username && <span>Signed in as {me.username} ·</span>}
            <button
              type="button"
              onClick={logout}
              className="inline-flex items-center gap-1 text-primary/70 hover:text-accent underline underline-offset-2 motion-safe:transition-colors"
            >
              <LogOut size={12} aria-hidden="true" />
              Sign out
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
