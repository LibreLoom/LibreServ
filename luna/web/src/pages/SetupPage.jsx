import { cn } from "@/lib/utils";
import { useState, useEffect, useCallback, useRef, useContext } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, ArrowRight, Cable, Check, Eye, EyeOff, Lock, Router, X } from "lucide-react";
import PropTypes from "prop-types";
import { getJson, postJson } from "../lib/api";
import NetworkStep from "../components/setup/NetworkStep";
import { useAuth } from "../context/AuthContext";
import { useAnimatedHeight } from "../hooks/useAnimatedHeight";
import { StepTransitionContext } from "../components/setup/StepTransitionContext";
import { StepTransitionProvider } from "../components/setup/StepTransition";
import Button from "../components/ui/Button";
import TextLink from "../components/ui/TextLink";

// ─── Step constants ───────────────────────────────────────────────────────────
const STEP = {
  WELCOME:    "welcome",
  NETWORK:    "network",
  ACCOUNT:    "account",
  NAME:       "name",
  DONE:       "done",
};

// Shared input style for the inverted (bg-secondary) setup card: a transparent
// field with a primary-toned border; text is primary (inverted to match the card).
// Same constant as LibreServ's SetupPage so the two wizards read identically.
const WIZARD_INPUT_CLASS =
  "w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/50 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150";

// ─── Full-screen shell (bg-primary = page background) ────────────────────────
function SetupShell({ children }) {
  return (
    <div data-slot="setup-page" className="min-h-screen flex flex-col items-center justify-center bg-primary px-4 py-12">
      {children}
    </div>
  );
}
SetupShell.propTypes = { children: PropTypes.node.isRequired };

// ─── Card surface (bg-secondary = inverted, high contrast) ───────────────────
// All step content lives on this card. Text inside uses text-primary (inverted).
// Wraps content in an animated-height container so the card resizes smoothly
// when a step's content height changes (appearing forms, errors, the address
// list, etc.) instead of snapping.
//
// The card itself does NOT fly in on mount — it stays in place and smoothly
// resizes (useAnimatedHeight). Step-to-step transitions slide the INNER content
// in from the right (advancing) or left (going back), keyed so it remounts and
// the slide replays within the card bounds (overflow-hidden clips the offset).
// Direction/key come from StepTransitionContext, provided by SetupPage.
function SetupCard({ children, className = "", header = null }) {
  const { outerRef, innerRef } = useAnimatedHeight();
  const { key: tKey, direction } = useContext(StepTransitionContext);
  return (
    <div
      ref={outerRef}
      className="w-full max-w-md bg-secondary text-primary rounded-large-element shadow-[0_32px_80px_rgba(0,0,0,0.12)] overflow-hidden transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
      style={{ transitionDuration: "var(--motion-duration-medium2)" }}
    >
      <div ref={innerRef} className="px-10 py-10">
        {header}
        <div
          key={tKey}
          className={cn(className, "animate-in duration-300", direction === "left" ? "slide-in-from-left-pop" : "slide-in-from-right-pop")}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
SetupCard.propTypes = {
  children:  PropTypes.node.isRequired,
  className: PropTypes.string,
  header:    PropTypes.node,
};

// ─── Step progress dots (on the card, so use primary colors) ─────────────────
// The shared indicator across both products: a plain row of dots — active is
// a wider pill (smoothly stretched via transition-all, no entrance cascade,
// no breathe) — plus LibreServ's "N / M" step counter on the right.
// Shown on every step, including Welcome.
const VISIBLE_STEPS = [
  { id: STEP.WELCOME,    label: "Welcome" },
  { id: STEP.NETWORK,    label: "Network" },
  { id: STEP.ACCOUNT,    label: "Account" },
  { id: STEP.NAME,       label: "Name" },
  { id: STEP.DONE,       label: "Done" },
];

function StepDots({ current }) {
  const idx = VISIBLE_STEPS.findIndex((s) => s.id === current);
  if (idx < 0) return null;
  return (
    <div className="flex items-center gap-2 mb-8">
      {VISIBLE_STEPS.map((s, i) => (
        <div
          key={s.id}
          className={cn(
            "rounded-full motion-safe:transition-all motion-safe:duration-300",
            i === idx
              ? "w-5 h-2 bg-primary"
              : i < idx
                ? "w-2 h-2 bg-primary/40"
                : "w-2 h-2 bg-primary/15"
          )}
          title={s.label}
          aria-label={s.label}
        />
      ))}
      <span className="ml-auto text-[11px] font-mono tracking-wider text-primary/30 animate-in fade-in duration-300">
        {idx + 1} / {VISIBLE_STEPS.length}
      </span>
    </div>
  );
}
StepDots.propTypes = { current: PropTypes.string.isRequired };

// ─── Logo mark (inline SVG — theme-aware, renders on the inverted setup card) ─
// The accent (#767676) border is constant; the white/black face and dot invert
// with bg-secondary so the mark stays readable in both themes.
function LogoMark({ size = 64 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 240 240"
      fill="none"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <rect x="0" y="0" width="240" height="240" rx="32" fill="var(--color-accent)" />
      <rect x="2" y="2" width="236" height="236" rx="30" fill="var(--color-primary)" />
      <circle cx="200" cy="200" r="24" fill="var(--color-secondary)" stroke="var(--color-accent)" strokeWidth="2" />
    </svg>
  );
}
LogoMark.propTypes = { size: PropTypes.number };

/** Discovery paths — where to find Luna after install (console + setup wizard). */
function DiscoveryPaths({ name = "Luna" }) {
  const label = name || "Luna";
  return (
    <div className="mt-8 w-full bg-primary/10 border border-primary/15 rounded-large-element p-5 text-left">
      <p className="text-xs text-primary/60 mb-3">
        You can find {label} at:
      </p>
      <ul className="space-y-2.5 text-xs">
        <li className="flex items-center gap-2.5">
          <Cable size={14} className="text-primary/50 shrink-0" />
          <span className="font-mono text-primary shrink-0">luna.local</span>
          <span className="text-primary/50">— most phones and computers</span>
        </li>
        <li className="flex items-center gap-2.5">
          <Router size={14} className="text-primary/50 shrink-0" />
          <span className="font-mono text-primary shrink-0">http://luna</span>
          <span className="text-primary/50">— through your internet box</span>
        </li>
        <li className="flex items-center gap-2.5">
          <Check size={14} className="text-primary/50 shrink-0" />
          <span className="font-mono text-primary shrink-0">http://169.254.42.42</span>
          <span className="text-primary/50">— cable straight from a computer, always works</span>
        </li>
      </ul>
      <p className="mt-3 text-xs text-primary/60">
        No Wi-Fi yet? Join the open network <span className="font-mono text-primary">Luna Setup</span> from your phone.
      </p>
    </div>
  );
}
DiscoveryPaths.propTypes = {
  name: PropTypes.string,
};

// ─── STEP: Welcome ────────────────────────────────────────────────────────────
// Content-only: SetupPage renders the persistent shell (SetupShell + SetupCard
// with the dots header) around the current step, so the card and the dot row
// survive step changes and the active dot's width smoothly transitions.
function WelcomeStep({ onBegin }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-10">
        <LogoMark size={120} />
      </div>

      <h1 className="font-mono text-5xl font-normal text-primary tracking-tight mb-4">
        Luna
      </h1>

      <p className="text-primary/68 text-xl leading-[1.65] mb-8 max-w-[22rem]">
        Your files, your drives, your house. No subscription — ever.
      </p>

      <DiscoveryPaths />

      <Button
        variant="primary"
        onClick={onBegin}
        className="group mt-8 px-9 py-4 font-mono tracking-wide hover:scale-[1.03]"
      >
        Begin Setup
        <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
      </Button>
    </div>
  );
}
WelcomeStep.propTypes = {
  onBegin: PropTypes.func.isRequired,
};

// ─── Password strength (same policy display as LibreServ's account step) ──────
// Luna's backend policy is exactly "8+ characters"; letters/numbers/symbols are
// shown as encouraging chips but don't gate the button (gating on them would
// reject valid passwords the backend accepts).
function strengthInfo(pw) {
  if (!pw) return null;
  const hasLength  = pw.length >= 8;
  const hasLetter  = /[a-zA-Z]/.test(pw);
  const hasDigit   = /[0-9]/.test(pw);
  const hasSpecial = /[!@#$%^&*(),.?":{}|<>[\]\\;'`~\-_=+]/.test(pw);
  const score = [hasLength, hasLetter, hasDigit, hasSpecial].filter(Boolean).length;
  return { score, hasLength, hasLetter, hasDigit, hasSpecial };
}

const STRENGTH_LABEL = ["", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_COLOR = ["", "bg-error", "bg-warning", "bg-warning", "bg-success"];
const STRENGTH_TEXT  = ["", "text-error", "text-warning", "text-warning", "text-success"];

function PasswordStrengthBar({ score }) {
  return (
    <div className="flex gap-1 mt-2.5">
      {[1, 2, 3, 4].map((lvl) => (
        <div
          key={lvl}
          className={cn("h-1 flex-1 rounded-full motion-safe:transition-all motion-safe:duration-300", lvl <= score ? STRENGTH_COLOR[score] : "bg-primary/15")}
        />
      ))}
    </div>
  );
}
PasswordStrengthBar.propTypes = { score: PropTypes.number.isRequired };

/** A single password requirement chip: green check when met, muted X when missing. */
function ReqChip({ ok, label }) {
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono motion-safe:transition-colors motion-safe:duration-200", ok ? "text-success" : "text-primary/50")}>
      {ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
      {label}
    </span>
  );
}
ReqChip.propTypes = { ok: PropTypes.bool.isRequired, label: PropTypes.string.isRequired };

/** @param {{ id: any, label: any, hint?: any, children: any }} _ */
function FormField({ id, label, hint, children }) {
  return (
    <div>
      <label htmlFor={id} className="block text-primary/80 font-sans text-sm text-left translate-x-5 mb-1">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-primary/70 mt-1.5 translate-x-5">{hint}</p>}
    </div>
  );
}
FormField.propTypes = {
  id:       PropTypes.string.isRequired,
  label:    PropTypes.string.isRequired,
  hint:     PropTypes.string,
  children: PropTypes.node.isRequired,
};

// ─── STEP: Account ────────────────────────────────────────────────────────────
function AccountStep({ hasAdmin, onContinue }) {
  const { user, register, login } = useAuth();
  const [form, setForm] = useState({
    display_name:     "",
    username:         "",
    password:         "",
    confirm_password: "",
  });
  const [showPw, setShowPw]       = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState(null);

  const pw       = form.password;
  const confirm  = form.confirm_password;
  const strength = strengthInfo(pw);
  const meetsPolicy = !!strength?.hasLength;
  const usernameOk  = form.username.trim().length >= 3;
  const confirmOk   = confirm === pw && pw !== "";
  const isValid = !!(usernameOk && pw && meetsPolicy && confirmOk);

  const handleChange = (e) => {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
    if (fieldError) setFieldError(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    setFieldError(null);
    try {
      const displayName = form.display_name.trim() || form.username.trim();
      await register(form.username.trim(), displayName, pw);
      await login(form.username.trim(), pw);
      onContinue();
    } catch (err) {
      setFieldError(err.message);
      setSubmitting(false);
    }
  };

  // Luna already has an account — the wizard can't create another one.
  if (hasAdmin) {
    if (user) {
      return (
        <div className="flex flex-col items-center text-center">
          <div className="mb-7 w-16 h-16 rounded-full border border-primary/20 flex items-center justify-center animate-in fade-in duration-300">
            <Check className="w-7 h-7 text-primary" strokeWidth={1.5} />
          </div>
          <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-100">
            You&rsquo;re signed in
          </h2>
          <p className="text-primary/50 text-sm leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
            Signed in as <span className="font-mono text-primary">{user.username}</span>. This account manages Luna.
          </p>
          <div className="mt-8 animate-in fade-in duration-300 delay-300">
            <Button
              variant="primary"
              onClick={onContinue}
              className="group px-9 py-4 font-mono tracking-wide hover:scale-[1.03]"
            >
              Continue
              <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center text-center">
        <div className="mb-7 w-16 h-16 rounded-full border border-primary/20 flex items-center justify-center animate-in fade-in duration-300">
          <Lock className="w-7 h-7 text-primary" strokeWidth={1.5} />
        </div>
        <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-100">
          Sign in to continue
        </h2>
        <p className="text-primary/50 text-sm leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
          This Luna already has an account. Sign in with it to finish setup.
        </p>
        <div className="mt-8 animate-in fade-in duration-300 delay-300">
          <TextLink
            to="/login"
            surface="secondary"
            state={{ from: "/setup" }}
            className="font-mono text-sm underline underline-offset-4"
          >
            Sign in
          </TextLink>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Header */}
      <div className="mb-8">
          <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
            Create your account
          </h2>
          <p className="text-primary/50 text-sm mt-2">
            This account protects every file on Luna. You can add people for the rest of your household later.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Your name */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-75">
            <FormField id="display_name" label="Your name" hint="Shown on this Luna when you sign in">
              <input
                id="display_name"
                name="display_name"
                type="text"
                autoComplete="name"
                placeholder="e.g. Alex"
                value={form.display_name}
                onChange={handleChange}
                disabled={submitting}
                className={WIZARD_INPUT_CLASS}
              />
            </FormField>
          </div>

          {/* Username */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-150">
            <FormField id="username" label="Username" hint="How you sign in — letters, numbers, dots, or dashes">
              <input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                placeholder="alex"
                value={form.username}
                onChange={handleChange}
                disabled={submitting}
                required
                className={WIZARD_INPUT_CLASS}
              />
            </FormField>
          </div>

          {/* Password */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
            <FormField id="password" label="Password">
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={showPw ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  value={pw}
                  onChange={handleChange}
                  disabled={submitting}
                  required
                  className={cn(WIZARD_INPUT_CLASS, "pr-12")}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-primary/30 hover:text-primary/60 motion-safe:transition-colors motion-safe:duration-150"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {/* Strength bar + label */}
              {strength && (
                <div className="mt-1">
                  <PasswordStrengthBar score={strength.score} />
                  <div className="flex items-center justify-between mt-1.5">
                    <p className={cn("text-xs font-mono", STRENGTH_TEXT[strength.score])}>
                      {STRENGTH_LABEL[strength.score]}
                    </p>
                    <p className={cn("text-xs font-mono", meetsPolicy ? "text-success" : "text-primary/50")}>
                      {meetsPolicy ? "✓ Acceptable" : "Not strong enough yet"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
                    <ReqChip ok={strength.hasLength}  label="8+ chars" />
                    <ReqChip ok={strength.hasLetter}  label="letters" />
                    <ReqChip ok={strength.hasDigit}   label="numbers" />
                    <ReqChip ok={strength.hasSpecial} label="symbols" />
                  </div>
                </div>
              )}
            </FormField>
          </div>

          {/* Confirm password */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-250">
            <FormField id="confirm_password" label="Confirm password" hint={confirmOk && pw ? "Passwords match" : undefined}>
              <div className="relative">
                <input
                  id="confirm_password"
                  name="confirm_password"
                  type={showPw ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="Re-enter your password"
                  value={confirm}
                  onChange={handleChange}
                  disabled={submitting}
                  required
                  className={cn(WIZARD_INPUT_CLASS, "pr-12")}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-primary/30 hover:text-primary/60 motion-safe:transition-colors motion-safe:duration-150"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {confirm && !confirmOk && (
                <p className="text-xs text-error mt-1.5 translate-x-5">
                  Passwords don&rsquo;t match
                </p>
              )}
            </FormField>
          </div>

          {/* Inline error */}
          {fieldError && (
            <div className="flex items-start gap-2.5 p-4 rounded-card border border-error/25 bg-error/10 animate-in fade-in slide-in-from-bottom-1 duration-200">
              <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
              <p className="text-sm text-primary/80">{fieldError}</p>
            </div>
          )}

          {/* Submit */}
          <div className="pt-2 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-300">
            <Button
              type="submit"
              variant="primary"
              fullWidth
              loading={submitting}
              disabled={!isValid || submitting}
              className="group py-4 font-mono tracking-wide hover:scale-[1.02]"
            >
              {submitting ? (
                "Creating account…"
              ) : (
                <>
                  Create account
                  <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
                </>
              )}
            </Button>
          </div>
        </form>
    </>
  );
}
AccountStep.propTypes = {
  hasAdmin: PropTypes.bool.isRequired,
  onContinue: PropTypes.func.isRequired,
};

// ─── STEP: Name ───────────────────────────────────────────────────────────────
function NameStep({ initialName, onFinish }) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onFinish(trimmed);
    } catch (err) {
      setError(err?.message || "Luna couldn't save your name. Try again.");
      setSaving(false);
    }
  };

  return (
    <>
      {/* Header */}
      <div className="mb-8">
        <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
          Name your Luna
        </h2>
        <p className="text-primary/50 text-sm mt-2">
          This is the name you&rsquo;ll see when you open Luna. If you ever have two, each gets its own name.
        </p>
      </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-75">
            <FormField id="luna_name" label="Name" hint="1-40 characters">
              <input
                id="luna_name"
                type="text"
                maxLength={40}
                autoComplete="off"
                value={name}
                onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
                disabled={saving}
                required
                className={WIZARD_INPUT_CLASS}
              />
            </FormField>
          </div>

          {/* Inline error */}
          {error && (
            <div className="flex items-start gap-2.5 p-4 rounded-card border border-error/25 bg-error/10 animate-in fade-in slide-in-from-bottom-1 duration-200">
              <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
              <p className="text-sm text-primary/80">{error}</p>
            </div>
          )}

          {/* Submit */}
          <div className="pt-2 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-150">
            <Button
              type="submit"
              variant="primary"
              fullWidth
              loading={saving}
              disabled={!name.trim() || saving}
              className="group py-4 font-mono tracking-wide hover:scale-[1.02]"
            >
              {saving ? (
                "Finishing…"
              ) : (
                <>
                  Finish setup
                  <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
                </>
              )}
            </Button>
          </div>
        </form>
    </>
  );
}
NameStep.propTypes = {
  initialName: PropTypes.string,
  onFinish: PropTypes.func.isRequired,
};

// ─── STEP: Done ───────────────────────────────────────────────────────────────
function DoneStep({ name, onGoDrives }) {
  const label = name || "Luna";
  return (
    <div className="flex flex-col items-center text-center">
      {/* Check circle */}
      <div className="mb-7 w-16 h-16 rounded-full border border-primary/20 flex items-center justify-center animate-in fade-in duration-300">
        <Check className="w-7 h-7 text-primary" strokeWidth={1.5} />
      </div>

        <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-100">
          {label} is ready.
        </h2>
        <p className="text-primary/50 text-sm leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
          Now plug in a USB drive. Luna will notice and won&rsquo;t touch a thing until you say so.
        </p>

        {/* Discovery paths — where to find Luna after setup */}
        <DiscoveryPaths name={label} />

        <div className="mt-6 w-full bg-primary text-secondary rounded-large-element p-5 text-left animate-in fade-in duration-300 delay-300">
          <p className="font-mono text-sm text-secondary mb-3">
            If you forget your password
          </p>
          <ol className="space-y-2 text-sm text-secondary list-decimal list-inside">
            <li>Plug a USB keyboard into Luna.</li>
            <li>Press Esc, then type luna, then press Enter.</li>
            <li>On the screen plugged into Luna, type a new password twice.</li>
          </ol>
          <p className="mt-3 text-sm text-secondary">
            Write this down. It only works with a keyboard on the box — never from the internet.
          </p>
        </div>

        <div className="mt-8 animate-in fade-in duration-300 delay-400">
          <Button
            variant="primary"
            onClick={onGoDrives}
            className="group px-9 py-4 font-mono tracking-wide hover:scale-[1.03]"
          >
            Go to drives
            <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
          </Button>
        </div>
    </div>
  );
}
DoneStep.propTypes = {
  name: PropTypes.string,
  onGoDrives: PropTypes.func.isRequired,
};

// ─── Root: SetupPage ──────────────────────────────────────────────────────────

// Linear order of the wizard's main steps, used to derive the slide direction
// (forward → slide from right, back → slide from left) on step change.
const STEP_ORDER = [
  STEP.WELCOME,
  STEP.NETWORK,
  STEP.ACCOUNT,
  STEP.NAME,
  STEP.DONE,
];

export default function SetupPage() {
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const [step, setStep] = useState(STEP.WELCOME);
  const [animationDirection, setAnimationDirection] = useState("right");
  const prevStepRef = useRef(null);
  const [hasAdmin, setHasAdmin] = useState(false);
  const [deviceName, setDeviceName] = useState("Luna");

  // Whether an account already exists (decides if the account step creates or
  // signs in). Re-checked whenever the signed-in user changes.
  useEffect(() => {
    let alive = true;
    getJson("/api/v1/auth/status")
      .then((data) => { if (alive) setHasAdmin(Boolean(data?.has_admin)); })
      .catch(() => { /* offline — the account step will surface the error */ });
    return () => { alive = false; };
  }, [user]);

  // Derive the slide direction from the linear step order so the transition
  // matches travel direction: advancing slides the new step in from the right,
  // going back slides it in from the left. Initial mount has no slide.
  useEffect(() => {
    if (step == null || prevStepRef.current == null) {
      prevStepRef.current = step;
      return;
    }
    if (step === prevStepRef.current) return;
    const prevIdx = STEP_ORDER.indexOf(prevStepRef.current);
    const nextIdx = STEP_ORDER.indexOf(step);
    if (prevIdx >= 0 && nextIdx >= 0) {
      setAnimationDirection(nextIdx > prevIdx ? "right" : "left");
    }
    prevStepRef.current = step;
  }, [step]);

  const handleBegin = useCallback(() => setStep(STEP.NETWORK), []);
  const handleConnectionDone = useCallback(() => setStep(STEP.ACCOUNT), []);
  const handleAccountContinue = useCallback(() => setStep(STEP.NAME), []);

  const handleFinish = useCallback(async (name) => {
    // Throws on failure so NameStep keeps its input and stays on the step.
    const saved = await postJson("/api/v1/setup", { name, setup_completed: true });
    setDeviceName(saved?.name || name);
    // Refresh the auth context so RequireAuth sees setup_completed === true
    // and lets the post-setup navigation through.
    await refresh();
    setStep(STEP.DONE);
  }, [refresh]);

  let renderedStep;
  if (step === STEP.WELCOME) {
    renderedStep = <WelcomeStep onBegin={handleBegin} />;
  } else if (step === STEP.NETWORK) {
    renderedStep = <NetworkStep name="Luna" onContinue={handleConnectionDone} />;
  } else if (step === STEP.ACCOUNT) {
    renderedStep = <AccountStep hasAdmin={hasAdmin} onContinue={handleAccountContinue} />;
  } else if (step === STEP.NAME) {
    renderedStep = <NameStep initialName={deviceName} onFinish={handleFinish} />;
  } else if (step === STEP.DONE) {
    renderedStep = <DoneStep name={deviceName} onGoDrives={() => navigate("/drives")} />;
  }

  // One persistent shell for the whole wizard. Because the SetupShell +
  // SetupCard (and thus the dot row in the header) survive step changes, the
  // active dot's width smoothly transitions (transition-all) and the card
  // resizes smoothly (useAnimatedHeight) as you move between steps — only the
  // inner content remounts and slides. Each step is content-only for this.
  return (
    <StepTransitionProvider stepKey={step} direction={animationDirection}>
      <SetupShell>
        <SetupCard header={<StepDots current={step} />}>
          {renderedStep}
        </SetupCard>
      </SetupShell>
    </StepTransitionProvider>
  );
}
