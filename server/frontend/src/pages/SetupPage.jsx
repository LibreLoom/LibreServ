import { cn } from "@/lib/utils";
import { PLACEHOLDER_TEXT } from "@/lib/ui-tokens";
import { useState, useEffect, useCallback, useMemo, useRef, useContext } from "react";
import { useNavigate } from "react-router-dom";
import { Check, X, AlertCircle, Loader2, ArrowRight, Eye, EyeOff, ShieldCheck } from "lucide-react";
import PropTypes from "prop-types";
import api from "../lib/api";
import ExternalServicesStep from "../components/setup/ExternalServicesStep";
import NetworkStep from "../components/setup/NetworkStep";
import PreflightRemediation from "../components/setup/PreflightRemediation";
import { summarizeError } from "../lib/preflight-errors";
import useSetupProgress from "../hooks/useSetupProgress";
import { useAuth } from "../hooks/useAuth";
import { useAnimatedHeight } from "../hooks/useAnimatedHeight";
import { StepTransitionContext } from "../components/setup/StepTransitionContext";
import { StepTransitionProvider } from "../components/setup/StepTransition";
import { MfaSetupWizard } from "../components/profile/MfaCard";
import Button from "../components/ui/Button";
import ShakeTarget from "../components/ui/ShakeTarget";
import useLabelErrorState from "../hooks/useLabelErrorState";
import Login from "./Login";

// ─── Step constants ───────────────────────────────────────────────────────────
const STEP = {
  SETUP_CODE:  "setup_code",
  WELCOME:      "welcome",
  PREFLIGHT:   "preflight",
  NETWORK:     "network",
  ACCOUNT:     "account",
  EXTERNAL_SERVICES: "external_services",
  MFA:         "mfa",
  CREATING:    "creating",
  COMPLETE:    "complete",
  ERROR:       "error",
};

const SETUP_TOKEN_KEY = "libreserv_setup_token";
const LOGIN_GATE_STEPS = new Set([STEP.MFA]);

// Shared input style for the inverted (bg-secondary) setup card: a transparent
// field with a primary-toned border; text is primary (inverted to match the card).
const WIZARD_INPUT_CLASS = cn(
  "w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150",
  PLACEHOLDER_TEXT,
);

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
// when a step's content height changes (phase transitions, appearing errors,
// QR/codes, etc.) instead of snapping. Mirrors the Card component's approach.
//
// The card itself does NOT fly in on mount — it stays in place and smoothly
// resizes (useAnimatedHeight). Step-to-step transitions slide the INNER content
// in from the right (advancing) or left (going back), keyed so it remounts and
// the slide replays within the card bounds (overflow-hidden clips the offset).
// Direction/key come from StepTransitionContext, provided by SetupPage.
// Callers pass only LAYOUT classes (e.g. flex centering) via className (applied
// to the sliding content) and `header` for static chrome (e.g. StepDots) that must
// NOT slide — it stays put while the step content below it flies in/out.
function SetupCard({ children, className = "", header = null }) {
  const { outerRef, innerRef } = useAnimatedHeight();
  const { key: tKey, direction } = useContext(StepTransitionContext);
  // Drop the slide classes once the entrance animation finishes so that Chrome
  // can't replay them when a child input receives :focus or a style-recalc
  // fires (the animation-name stays live on the element otherwise).
  const [sliding, setSliding] = useState(true);
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
          className={cn(
            className,
            sliding && "animate-in duration-300",
            sliding && (direction === "left" ? "slide-in-from-left-pop" : "slide-in-from-right-pop"),
          )}
          // backwards (not both): during the slide, hold the from-state before
          // the animation starts; once done the classes are removed entirely.
          style={sliding ? { animationFillMode: "backwards" } : undefined}
          onAnimationEnd={() => setSliding(false)}
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
// The shared indicator across both products: a plain row of dots where the
// active dot smoothly stretches into a wider pill (transition-all — no
// entrance cascade, no breathe), plus the "N / M" step counter on the right.
const VISIBLE_STEPS = [
  { id: STEP.WELCOME,           label: "Welcome" },
  { id: STEP.PREFLIGHT,         label: "System check" },
  { id: STEP.NETWORK,          label: "Network" },
  { id: STEP.ACCOUNT,           label: "Account" },
  { id: STEP.EXTERNAL_SERVICES, label: "Connect" },
  { id: STEP.MFA,               label: "MFA" },
  { id: STEP.COMPLETE,          label: "Done" },
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

// ─── Step transition (directional slide within the card) ───────────────────
// SetupPage provides { key, direction } via StepTransitionContext (imported
// from ../components/setup/StepTransition). SetupCard consumes it and slides
// its INNER content in from the right (advancing) or left (going back), keyed
// so React remounts the content subtree and the slide replays. The card shell
// itself stays in place and smoothly resizes (useAnimatedHeight) — only the
// content within it flies in/out. Mirrors the app install wizard's
// slide-in-from-right-pop / -left-pop keyframes.

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

// ─── STEP: Setup Code ─────────────────────────────────────────────────────────
function SetupCodeStep({ onCodeVerified }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(async () => {
    const trimmed = code.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 6);
    if (trimmed.length !== 6) {
      setError("Please enter a 6-character setup code.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await api("/setup/validate-code", {
        method: "POST",
        body: JSON.stringify({ code: trimmed }),
        allowNonOk: true,
      });
      if (!res.ok) {
        const msg = res.status === 429
          ? "Too many attempts. Please wait a minute and try again."
          : "Invalid setup code. Check the code on your device card.";
        setError(msg);
        return;
      }
      onCodeVerified(trimmed);
    } catch {
      setError("Could not reach the server. Make sure you are on the same network.");
    } finally {
      setLoading(false);
    }
  }, [code, onCodeVerified]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === "Enter" && !loading) handleSubmit();
  }, [handleSubmit, loading]);

  return (
    <SetupShell>
      <SetupCard className="flex flex-col items-center text-center">
        <div className="mb-10">
          <LogoMark size={120} />
        </div>

        <h1 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3">
          Enter your setup code
        </h1>

        <p className="text-primary/42 text-base leading-relaxed mb-10 max-w-[20rem]">
          Enter the 6-character code from the card included with your device.
        </p>

        <div className="w-full mb-6">
          <ShakeTarget shake={error}>
            <input
              className={cn(WIZARD_INPUT_CLASS, "text-center text-2xl tracking-[0.3em]")}
              placeholder="______"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6));
                setError("");
              }}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              autoFocus
              disabled={loading}
            />
          </ShakeTarget>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-error text-sm mb-6">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Button
          variant="primary"
          onClick={handleSubmit}
          loading={loading}
          disabled={loading || code.length !== 6}
          className="group px-9 py-4 font-mono tracking-wide hover:scale-[1.03]"
        >
          Verify
          <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
        </Button>
      </SetupCard>
    </SetupShell>
  );
}
SetupCodeStep.propTypes = {
  onCodeVerified: PropTypes.func.isRequired,
};

// ─── STEP: Welcome ────────────────────────────────────────────────────────────
// Content-only: SetupPage renders ONE persistent shell (SetupShell + SetupCard
// with the dots header) around the current step, so the card and the dot row
// survive step changes and the active dot's width smoothly transitions.
function WelcomeStep({ onBegin }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="mb-10">
        <LogoMark size={120} />
      </div>

      <h1 className="font-mono text-5xl font-normal text-primary tracking-tight mb-4">
        Welcome.
      </h1>

      <p className="text-primary/68 text-xl leading-[1.65] mb-12 max-w-[22rem]">
        Let&rsquo;s get LibreServ set up for you.
      </p>

      <Button
        variant="primary"
        onClick={onBegin}
        className="group px-9 py-4 font-mono tracking-wide hover:scale-[1.03]"
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

// ─── STEP: Preflight ──────────────────────────────────────────────────────────
const KNOWN_CHECKS = new Set([
  "database", "database_writable", "data_path_writable", "logs_path_writable",
  "caddy_config_writable", "caddy_certs_writable",
  "acme_data_writable", "acme_certs_writable",
  "disk_space", "runtime",
]);

const CHECK_LABELS = {
  database:              "Database",
  database_writable:     "Database storage",
  data_path_writable:   "App storage",
  logs_path_writable:   "Log storage",
  caddy_config_writable: "Proxy config",
  caddy_certs_writable:  "SSL certificates",
  acme_data_writable:   "Certificate data",
  acme_certs_writable:  "Certificate storage",
  disk_space:           "Disk space",
  runtime:              "Runtime",
};

const CATEGORY_LABELS = {
  system:   "System",
  storage:  "Storage Permissions",
  network:  "Network Storage Permissions",
};

const CATEGORY_ORDER = ["system", "storage", "network"];

function PreflightRow({ name, check, delay, done, rerunning }) {
  const label  = CHECK_LABELS[name] ?? name.replace(/_/g, " ");
  const isOk   = check?.status === "ok";
  const isFail = check && check.status !== "ok";

  // While re-running we keep the previous result visible but dimmed.
  // Only show the spinner placeholder when there is no prior result at all.
  const showPrev  = rerunning && check;
  const showEmpty = !done && !check;

  // Use shared error summarization logic
  const shortError = isFail && check.error ? summarizeError(check.error) : null;

  return (
    <div
      className={cn("flex items-center gap-4 py-3.5 border-b border-primary/10 last:border-0 motion-safe:transition-opacity motion-safe:duration-300", rerunning ? "opacity-45" : "opacity-100", "animate-in fade-in slide-in-from-bottom-2 duration-400")}
      style={{ animationDelay: `${delay}ms` }}>
      {/* Status icon */}
      <div className={cn("flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center motion-safe:transition-all motion-safe:duration-300", showEmpty ? "bg-primary/10" : (isOk && !showEmpty) ? "bg-primary/15" : (isFail && !showEmpty) ? "bg-error/20" : "bg-primary/10")}>
        {showEmpty ? (
          <Loader2 className="w-3.5 h-3.5 text-accent animate-spin" />
        ) : isOk ? (
          <Check className="w-3.5 h-3.5 text-accent" />
        ) : (
          <X className="w-3.5 h-3.5 text-error" />
        )}
      </div>

      {/* Label + detail */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm text-primary capitalize">{label}</span>
          {isFail && shortError && (
            <span className="text-xs text-error/75 truncate">
              ({shortError})
            </span>
          )}
        </div>
        {name === "disk_space" && isOk && check.disk_space_bytes_free && (
          <p className="text-xs text-accent mt-0.5">
            {Math.round((check.disk_space_bytes_free / (1024 * 1024 * 1024)) * 10) / 10} GB free
          </p>
        )}
      </div>

      {/* Pass/fail badge — keep visible while re-running so layout doesn't shift */}
      {(done || showPrev) && check && (
        <span className={cn("flex-shrink-0 font-mono text-[10px] tracking-widest uppercase motion-safe:transition-opacity motion-safe:duration-300", isOk ? "text-primary/30" : "text-error")}>
          {isOk ? "ok" : "fail"}
        </span>
      )}
    </div>
  );
}
PreflightRow.propTypes = {
  name:      PropTypes.string.isRequired,
  check:     PropTypes.object,
  index:     PropTypes.number.isRequired,
  done:      PropTypes.bool.isRequired,
  rerunning: PropTypes.bool,
};

function PreflightStep({ onPass }) {
  const [checks, setChecks]     = useState(null);
  const [healthy, setHealthy]   = useState(null);
  const [error, setError]       = useState(null);
  const [running, setRunning]   = useState(false);

  const runChecks = useCallback(async () => {
    setRunning(true);
    setError(null);

    try {
      const res = await api("/setup/preflight", { allowNonOk: true, noRetry: true });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      if (data.checks) {
        setChecks(data.checks);
        setHealthy(data.healthy);
      } else {
        throw new Error("Server returned an unexpected response.");
      }
    } catch (err) {
      setError(`Could not reach the server: ${err.message}`);
    } finally {
      setRunning(false);
    }
  }, []);

  // Run on mount
  useEffect(() => { runChecks(); }, [runChecks]);

  const checkEntries = useMemo(() =>
    checks
      ? Object.entries(checks).filter(([name]) => KNOWN_CHECKS.has(name))
      : [],
    [checks]);
  const hasCheckResults = checkEntries.length > 0;
  const showSkeleton = !hasCheckResults && running && !error;
  const rerunning = running && hasCheckResults;
  const done      = checks !== null && !running;
  const hasFailed = done && healthy === false;
  const allPassed = done && healthy === true;
  const showRerunButton = hasFailed || error || rerunning;

  const checksByCategory = useMemo(() => {
    if (!hasCheckResults) return {};
    const grouped = {};
    for (const [name, check] of checkEntries) {
      const cat = check?.category || "system";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push([name, check]);
    }
    return grouped;
  }, [checkEntries, hasCheckResults]);

  return (
    <>
      {/* Header */}
        <div className="mb-7">
          <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
            System check
          </h2>
          <p className="text-accent text-sm mt-2">
            Verifying your environment before we continue.
          </p>
        </div>

        {/* Check list */}
        <div className="mb-6">
          {/* Skeleton rows while loading */}
          {showSkeleton && (
            <div>
              {Array.from({ length: 5 }, (_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-4 py-3.5 border-b border-primary/10 last:border-0 animate-in fade-in duration-300"
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
                    <Loader2 className="w-3.5 h-3.5 text-primary/25 animate-spin" />
                  </div>
                  <div className="h-3 rounded-full bg-primary/10" style={{ width: `${50 + i * 9}%` }} />
                </div>
              ))}
            </div>
          )}

          {/* Grouped check rows */}
          {hasCheckResults && CATEGORY_ORDER.map((category) => {
            const catChecks = checksByCategory[category];
            if (!catChecks || catChecks.length === 0) return null;
            return (
              <div key={category}>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent mt-5 mb-1 first:mt-0">
                  {CATEGORY_LABELS[category] || category}
                </p>
                {catChecks.map(([name, check], i) => (
                  <PreflightRow
                    key={name}
                    name={name}
                    check={check}
                    delay={i * 80}
                    done={done || rerunning}
                    rerunning={rerunning}
                  />
                ))}
              </div>
            );
          })}

          {/* Network error */}
          {error && (
            <div className="flex items-start gap-3 p-4 rounded-card border border-error/25 bg-error/10 animate-in fade-in duration-300">
              <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
              <p className="text-sm text-primary">{error}</p>
            </div>
          )}
        </div>

        {/* Status line + remediation */}
        <div className="mb-5">
          {running && (
            <p className="text-xs text-primary/35 animate-in fade-in duration-300 h-6">
              Running checks&hellip;
            </p>
          )}
          {allPassed && (
            <p className="text-xs text-accent animate-in fade-in duration-300 h-6">
              All checks passed.
            </p>
          )}
          {hasFailed && (
            <div className="animate-in fade-in slide-in-from-bottom-1 duration-500 ease-out">
              <p className="text-xs text-error/70 flex items-center gap-1.5 mb-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                Some checks failed. Fix the issues above and retry.
              </p>
              <PreflightRemediation failedChecks={checkEntries} />
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-3">
          {/* Continue — only when all passed */}
          {allPassed && (
            <Button
              variant="primary"
              fullWidth
              onClick={onPass}
              className="group py-4 font-mono tracking-wide hover:scale-[1.02] animate-in fade-in slide-in-from-bottom-2 duration-300"
            >
              Continue
              <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
            </Button>
          )}

          {/* Re-run — when failed or errored */}
          {showRerunButton && (
            <Button
              variant="outline"
              surface="secondary"
              fullWidth
              onClick={runChecks}
              loading={running}
              className="py-3.5 font-mono animate-in fade-in slide-in-from-bottom-2 duration-300"
            >
              Re-run checks
            </Button>
          )}
        </div>
    </>
  );
}
PreflightStep.propTypes = {
  onPass: PropTypes.func.isRequired,
};

// ─── STEP: Account creation ───────────────────────────────────────────────────
function strengthInfo(pw) {
  if (!pw) return null;
  const hasLength  = pw.length >= 12;
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
    <span className={cn("inline-flex items-center gap-1 font-mono motion-safe:transition-colors motion-safe:duration-200", ok ? "text-success" : "text-accent")}>
      {ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
      {label}
    </span>
  );
}
ReqChip.propTypes = { ok: PropTypes.bool.isRequired, label: PropTypes.string.isRequired };

/** @param {{ id: any, label: any, hint?: any, children: any }} _ */
function FormField({ id, label, hint, children, error, shake, loading = false }) {
  const { labelError, containerRef } = useLabelErrorState(error, shake, { loading });
  return (
    <div ref={containerRef}>
      <label
        htmlFor={id}
        className={cn(
          "block font-sans text-sm text-left translate-x-5 mb-1 motion-safe:transition-colors duration-300",
          labelError ? "text-error" : "text-primary",
        )}
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-accent mt-1.5 translate-x-5">{hint}</p>}
    </div>
  );
}
FormField.propTypes = {
  id:       PropTypes.string.isRequired,
  label:    PropTypes.string.isRequired,
  hint:     PropTypes.string,
  children: PropTypes.node.isRequired,
  error:    PropTypes.any,
  shake:    PropTypes.any,
  loading:  PropTypes.bool,
};

function AccountStep({ onSuccess, onError }) {
  const [form, setForm] = useState({
    admin_username: "",
    admin_email:    "",
    admin_password: "",
    confirm_password: "",
  });
  const [showPw, setShowPw]         = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState(null);

  const pw       = form.admin_password;
  const confirm  = form.confirm_password;
  const strength = strengthInfo(pw);
  // Acceptable matches the backend policy exactly: 12+ chars, a letter, and a
  // digit. Symbols strengthen the password but are NOT required — gating on
  // them would reject valid passwords the backend accepts.
  const meetsPolicy = !!(strength?.hasLength && strength?.hasLetter && strength?.hasDigit);
  const confirmOk   = confirm === pw && pw !== "";
  const isValid  =
    !!(form.admin_username.trim() &&
    form.admin_email.trim() &&
    pw &&
    meetsPolicy &&
    confirmOk);

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
      const res = await api("/setup/complete", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ ...form, confirm_password: undefined }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Setup failed");
      }
      onSuccess(form.admin_email);
    } catch (err) {
      setFieldError(err.message);
      setSubmitting(false);
      onError(err.message);
    }
  };

  const usernameShake =
    fieldError && /username/i.test(fieldError) ? fieldError : null;
  const emailShake =
    fieldError && /email/i.test(fieldError) ? fieldError : null;
  const passwordShake =
    fieldError && (!usernameShake && !emailShake || /password/i.test(fieldError))
      ? fieldError
      : null;

  return (
    <>
      {/* Header */}
        <div className="mb-8">
          <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
            Create your account
          </h2>
          <p className="text-accent text-sm mt-2">
            This will be the administrator account.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Username */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-75">
            <ShakeTarget shake={usernameShake}>
              <FormField id="admin_username" label="Username" hint="Used to sign in" shake={usernameShake} loading={submitting}>
                <input
                  id="admin_username"
                  name="admin_username"
                  type="text"
                  autoComplete="username"
                  placeholder="admin"
                  value={form.admin_username}
                  onChange={handleChange}
                  disabled={submitting}
                  required
                  className={WIZARD_INPUT_CLASS}
                />
              </FormField>
            </ShakeTarget>
          </div>

          {/* Email */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-150">
            <ShakeTarget shake={emailShake}>
              <FormField id="admin_email" label="Email" hint="For notifications and account recovery" shake={emailShake} loading={submitting}>
                <input
                  id="admin_email"
                  name="admin_email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={form.admin_email}
                  onChange={handleChange}
                  disabled={submitting}
                  required
                  className={WIZARD_INPUT_CLASS}
                />
              </FormField>
            </ShakeTarget>
          </div>

          {/* Password */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
            <ShakeTarget shake={passwordShake}>
              <FormField id="admin_password" label="Password" shake={passwordShake} loading={submitting}>
                <div className="relative">
                <input
                  id="admin_password"
                  name="admin_password"
                  type={showPw ? "text" : "password"}
                  autoComplete="new-password"
                  placeholder="At least 12 characters"
                  value={pw}
                  onChange={handleChange}
                  disabled={submitting}
                  required
                  className={cn(WIZARD_INPUT_CLASS, "pr-12")}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="iconSm"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-accent hover:text-primary"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>

              {/* Strength bar + label */}
              {strength && (
                <div className="mt-1">
                  <PasswordStrengthBar score={strength.score} />
                  <div className="flex items-center justify-between mt-1.5">
                    <p className={cn("text-xs font-mono", STRENGTH_TEXT[strength.score])}>
                      {STRENGTH_LABEL[strength.score]}
                    </p>
                    <p className={cn("text-xs font-mono", meetsPolicy ? "text-success" : "text-accent")}>
                      {meetsPolicy ? "✓ Acceptable" : "Not strong enough yet"}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
                    <ReqChip ok={strength.hasLength}  label="12+ chars" />
                    <ReqChip ok={strength.hasLetter}  label="letters" />
                    <ReqChip ok={strength.hasDigit}   label="numbers" />
                    <ReqChip ok={strength.hasSpecial} label="symbols" />
                  </div>
                </div>
              )}
            </FormField>
            </ShakeTarget>
          </div>

          {/* Confirm password */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-250">
            <ShakeTarget shake={passwordShake}>
              <FormField id="confirm_password" label="Confirm password" hint={confirmOk && pw ? "Passwords match" : undefined} shake={passwordShake} loading={submitting}>
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
                <Button
                  type="button"
                  variant="ghost"
                  size="iconSm"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-accent hover:text-primary"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
              {confirm && !confirmOk && (
                <p className="text-xs text-error mt-1.5 translate-x-5">
                  Passwords don&rsquo;t match
                </p>
              )}
            </FormField>
            </ShakeTarget>
          </div>

          {/* Inline error */}
          {fieldError && (
            <div className="flex items-start gap-2.5 p-4 rounded-card border border-error/25 bg-error/10 animate-in fade-in slide-in-from-bottom-1 duration-200">
              <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
              <p className="text-sm text-primary">{fieldError}</p>
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
  onSuccess: PropTypes.func.isRequired,
  onError:   PropTypes.func.isRequired,
};

// ─── STEP: Complete ───────────────────────────────────────────────────────────
function CompleteStep() {
  return (
    <div className="flex flex-col items-center text-center">
      {/* Check circle */}
      <div className="mb-7 w-16 h-16 rounded-full border border-primary/20 flex items-center justify-center animate-in fade-in duration-300">
        <Check className="w-7 h-7 text-primary" strokeWidth={1.5} />
      </div>

      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-100">
        All done.
      </h2>
      <p className="text-accent text-sm animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
        Taking you to your dashboard&hellip;
      </p>

      <div className="mt-8 animate-in fade-in duration-300 delay-300">
        <Loader2 className="w-5 h-5 animate-spin text-primary/25" />
      </div>
    </div>
  );
}

// ─── STEP: Error (fatal) ──────────────────────────────────────────────────────
function ErrorStep({ message }) {
  return (
    <SetupShell>
      <SetupCard className="flex flex-col items-center text-center">
        <div className="mb-6 w-14 h-14 rounded-full border border-error/25 bg-error/12 flex items-center justify-center">
          <AlertCircle className="w-6 h-6 text-error" strokeWidth={1.5} />
        </div>
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent mb-3">
          Setup interrupted
        </p>
        <h2 className="font-mono text-2xl font-normal text-primary mb-4 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-75">
          Something went wrong
        </h2>
        <p className="text-sm text-primary/55 mb-8 leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300 delay-150">
          {message}
        </p>
        <Button
          variant="outline"
          surface="secondary"
          onClick={() => window.location.reload()}
          className="px-7 py-3.5 font-mono"
        >
          Try again
        </Button>
      </SetupCard>
    </SetupShell>
  );
}
ErrorStep.propTypes = { message: PropTypes.string };

// ─── STEP: MFA ──────────────────────────────────────────────────────────────────
function MfaStep({ onComplete, onSessionExpired }) {
  const [mfaPhase, setMfaPhase] = useState("choose");
  return (
    <>
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full border border-primary/15 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-accent" />
          </div>
          <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
            Enable MFA
          </h2>
        </div>
        {mfaPhase === "choose" && (
          <p className="text-accent text-sm leading-relaxed">
            Two-factor authentication asks for a second check at sign-in — not just your password. As an admin, your account is at higher risk, so you need at least one method before you can finish setup.
          </p>
        )}
      </div>

      <MfaSetupWizard
        onComplete={onComplete}
        onSessionExpired={onSessionExpired}
        onPhaseChange={setMfaPhase}
      />
    </>
  );
}
MfaStep.propTypes = {
  onComplete: PropTypes.func.isRequired,
  onSessionExpired: PropTypes.func,
};

// ─── Root: SetupPage ──────────────────────────────────────────────────────────

// Linear order of the wizard's main steps, used to derive the slide direction
// (forward → slide from right, back → slide from left) on step change. Steps
// not on the forward path (error/setup_code/creating) are treated as neutral.
const STEP_ORDER = [
  STEP.SETUP_CODE,
  STEP.WELCOME,
  STEP.PREFLIGHT,
  STEP.NETWORK,
  STEP.ACCOUNT,
  STEP.EXTERNAL_SERVICES,
  STEP.MFA,
  STEP.COMPLETE,
];

export default function SetupPage() {
  const navigate        = useNavigate();
  const [step, setStep] = useState(null);
  const [animationDirection, setAnimationDirection] = useState("right");
  const prevStepRef = useRef(null);
  const [error, setError] = useState(null);
  const [showLoginGate, setShowLoginGate] = useState(false);
  const [setupToken, setSetupToken] = useState(() =>
    (typeof window !== "undefined" ? localStorage.getItem(SETUP_TOKEN_KEY) : "") || ""
  );
  const { saveProgress, flushProgress } = useSetupProgress();
  const { refreshAuth, request } = useAuth();
  const progressRef = useRef(/** @type {{ step?: string, subStep?: string, stepData?: Record<string, any> }} */ ({}));
  const savingRef = useRef(false);

  const handleCodeVerified = useCallback((code) => {
    setSetupToken(code);
    localStorage.setItem(SETUP_TOKEN_KEY, code);
    setStep(STEP.WELCOME);
  }, []);

  const advanceStep = useCallback(async (nextStep, subStep, stepData) => {
    const data = stepData || progressRef.current.stepData || {};
    progressRef.current = { step: nextStep, subStep: subStep || "", stepData: data };

    savingRef.current = true;
    try {
      await saveProgress(nextStep, subStep || "", data);
    } catch (err) {
      // The stored setup code is missing or no longer valid (e.g. the setup
      // state/nonce changed after a reset while a previous token is still in
      // localStorage). Re-prompt for the code instead of failing with a
      // generic error.
      const isSetupCodeError =
        err?.cause?.status === 403 &&
        typeof err?.message === "string" &&
        /setup code/i.test(err.message);
      if (isSetupCodeError) {
        localStorage.removeItem(SETUP_TOKEN_KEY);
        setSetupToken("");
        setStep(STEP.SETUP_CODE);
        return;
      }
      // Retry once on any error (covers 409 stale timestamp + transient failures)
      try {
        await saveProgress(nextStep, subStep || "", data);
      } catch {
        setError("Failed to save progress. Please try again.");
        setStep(STEP.ERROR);
        return;
      }
    } finally {
      savingRef.current = false;
    }

    setStep(nextStep);
  }, [saveProgress]);

  useEffect(() => {
    const handler = (e) => {
      if (savingRef.current) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Derive the slide direction from the linear step order so the transition
  // matches travel direction: advancing slides the new step in from the right,
  // going back slides it in from the left. Neutral steps (error/setup_code)
  // keep the previous direction so they don't flash. Initial mount has no slide.
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

  useEffect(() => {
    const check = async () => {
      try {
        const res  = await api("/setup/status");
        const data = await res.json();
        if (data.setup_state?.status === "complete") {
          navigate("/");
          return;
        }

        const hasToken = setupToken && setupToken.length === 6;
        const needsCode = data.code_required === true;

        if (needsCode && !hasToken) {
          setStep(STEP.SETUP_CODE);
          return;
        }

        const saved = data.progress;
        if (saved && saved.current_step && saved.current_step !== "welcome") {
          let step = saved.current_step;
          const savedData = saved.step_data || {};

          // Legacy: the network step was once keyed "wifi" — remap to the
          // current key so a saved wizard resumes on the network step.
          if (step === "wifi") step = STEP.NETWORK;

          if (step === STEP.ACCOUNT) {
            if (savedData.account_completed) {
              setStep(STEP.EXTERNAL_SERVICES);
              saveProgress(STEP.EXTERNAL_SERVICES, "", { ...savedData });
              return;
            }
            setStep(STEP.ACCOUNT);
            progressRef.current = { step: STEP.ACCOUNT, subStep: "", stepData: savedData };
            return;
          }

          // Legacy steps (remote_access, smtp) were removed from the wizard.
          // If a device has saved progress at one of those steps, skip forward
          // to the next live step.
          if (step === STEP.EXTERNAL_SERVICES || step === "remote_access" || step === "smtp") {
            if (savedData.connect_activated || savedData.external_services_skipped) {
              setStep(STEP.MFA);
              saveProgress(STEP.MFA, "", { ...savedData });
            } else {
              setStep(STEP.EXTERNAL_SERVICES);
              saveProgress(STEP.EXTERNAL_SERVICES, "", { ...savedData });
            }
            return;
          }

          if (step === STEP.MFA) {
            if (savedData.mfa_completed) {
              setStep(STEP.COMPLETE);
              saveProgress(STEP.COMPLETE, "", { ...savedData });
              return;
            }
            setStep(STEP.MFA);
            progressRef.current = { step: STEP.MFA, subStep: "", stepData: savedData };
            return;
          }

          setStep(step);
          progressRef.current = { step, subStep: "", stepData: savedData };
          return;
        }

        setStep(STEP.WELCOME);
      } catch {
        setError("Failed to connect to the server.");
        setStep(STEP.ERROR);
      }
    };
    check();
  }, [navigate, saveProgress, setupToken]);

  const handleBegin = useCallback(() => advanceStep(STEP.PREFLIGHT), [advanceStep]);

  const handlePreflightPass = useCallback(() => {
    const data = { ...(progressRef.current.stepData || {}), preflight_passed: true };
    advanceStep(STEP.NETWORK, "", data);
  }, [advanceStep]);

  // The network step has a single exit: the device is online (by cable,
  // Wi-Fi, or both). There is no "skip" — being offline can't advance.
  const handleNetworkContinue = useCallback(() => {
    const data = { ...(progressRef.current.stepData || {}), network_connected: true };
    advanceStep(STEP.ACCOUNT, "", data);
  }, [advanceStep]);

  const handleConnectActivate = useCallback(async (key) => {
    // /connect/activate is CSRF-protected (router.go CSRF group). The bare
    // api() helper doesn't inject X-CSRF-Token; useAuth().request does.
    try {
      await request("/connect/activate", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connect_key: key }),
      });
    } catch (err) {
      // Session expired: the token refresh failed, so the user is genuinely
      // logged out. Swap in the login form immediately — a dead "Session
      // expired" error with no way to sign in would softlock the wizard.
      if (err.name === "AuthError") {
        setShowLoginGate(true);
        return;
      }
      throw err;
    }
    // Auto-provisioning runs in the background on the server, and the MFA
    // step reads /auth/mfa/availability once on mount. Wait briefly for the
    // email service to come online before advancing — otherwise the email
    // option can be hidden even though it becomes ready a second later.
    // Bounded so a provisioning failure never blocks the wizard.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const res = await request("/connect/status");
        const status = await res.json();
        const smtpState = status?.services?.smtp?.state;
        if (smtpState && smtpState !== "disabled") break;
      } catch { /* keep polling until the deadline */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const data = { ...(progressRef.current.stepData || {}), connect_activated: true };
    await advanceStep(STEP.MFA, "", data);
  }, [advanceStep, request]);

  const handleExternalServicesSkip = useCallback(async () => {
    const data = { ...(progressRef.current.stepData || {}), external_services_skipped: true };
    await advanceStep(STEP.MFA, "", data);
  }, [advanceStep]);
  const handleAccountSuccess = useCallback(async (adminEmail) => {
    const data = { ...(progressRef.current.stepData || {}), account_completed: true, admin_email: adminEmail };
    progressRef.current.stepData = data;
    // The setup wizard just created the admin account and set auth cookies;
    // hydrate the auth context so MfaCard (which uses useAuth) works at the
    // MFA step later in the flow.
    await refreshAuth();
    advanceStep(STEP.EXTERNAL_SERVICES, "", data);
  }, [advanceStep, refreshAuth]);

  const handleMfaSuccess = useCallback(async () => {
    const data = { ...(progressRef.current.stepData || {}), mfa_completed: true };
    progressRef.current.stepData = data;
    try { await saveProgress(STEP.MFA, "", data); } catch { /* best effort */ }
    try {
      await api("/setup/finalize", { method: "POST" });
    } catch { /* best effort */ }
    await flushProgress();
    setStep(STEP.COMPLETE);
    setTimeout(() => { window.location.href = "/"; }, 1800);
  }, [saveProgress, flushProgress]);

  const handleAccountError = useCallback((msg) => {
    setError(msg);
  }, []);

  void error;

  // Session-requiring steps: the wizard created the admin account at the
  // ACCOUNT step, so once the user reaches EXTERNAL_SERVICES or MFA a valid
  // session must exist. Probe /auth/me on page load (and on entering these
  // steps) so an expired session surfaces the real login page immediately
  // instead of failing later with a dead "Session expired" error. The
  // handleConnectActivate/MfaSetupWizard AuthError paths are the backstop for
  // mid-flow expiry.
  useEffect(() => {
    if (step !== STEP.EXTERNAL_SERVICES && step !== STEP.MFA) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api("/auth/me");
        if (!res.ok && !cancelled) setShowLoginGate(true);
      } catch (err) {
        if (!cancelled && err.name === "AuthError") setShowLoginGate(true);
      }
    })();
    return () => { cancelled = true; };
  }, [step]);

  if (step === null) {
    return (
      <SetupShell>
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </SetupShell>
    );
  }

  if (showLoginGate) {
    return (
      <Login
        returnTo="/setup"
        notice="You got signed out. Our bad 😅"
        noticeDetail="Log in again and we&rsquo;ll bring you right back to setup."
        onLoginSuccess={() => {
          setShowLoginGate(false);
          refreshAuth().catch((err) => {
            console.error("Failed to refresh auth state after login:", err);
          });
        }}
      />
    );
  }

  if (step === STEP.ERROR) {
    return <ErrorStep message={error ?? "An unexpected error occurred."} />;
  }

  // SETUP_CODE renders its own shell (entry screen, no dots). Everything
  // else below shares ONE persistent shell, so the card and the dot row
  // survive step changes — that's what lets the active dot's width smoothly
  // transition and the card resize smoothly between steps.
  if (step === STEP.SETUP_CODE) {
    return (
      <StepTransitionProvider stepKey={step} direction={animationDirection}>
        <SetupCodeStep onCodeVerified={handleCodeVerified} />
      </StepTransitionProvider>
    );
  }

  let renderedStep;
  if (step === STEP.WELCOME) {
    renderedStep = <WelcomeStep onBegin={handleBegin} />;
  } else if (step === STEP.PREFLIGHT) {
    renderedStep = <PreflightStep onPass={handlePreflightPass} />;
  } else if (step === STEP.NETWORK) {
    renderedStep = <NetworkStep name="LibreServ" onContinue={handleNetworkContinue} />;
  } else if (step === STEP.EXTERNAL_SERVICES) {
    renderedStep = (
      <ExternalServicesStep
        onActivate={handleConnectActivate}
        onSkip={handleExternalServicesSkip}
      />
    );
  } else if (step === STEP.MFA) {
    renderedStep = (
      <MfaStep
        onComplete={handleMfaSuccess}
        onSessionExpired={() => setShowLoginGate(true)}
      />
    );
  } else if (step === STEP.ACCOUNT || step === STEP.CREATING) {
    renderedStep = (
      <AccountStep
        onSuccess={handleAccountSuccess}
        onError={handleAccountError}
      />
    );
  } else if (step === STEP.COMPLETE) {
    renderedStep = <CompleteStep />;
  }

  // One persistent shell for the wizard's main steps. Because the
  // SetupShell + SetupCard (and thus the dot row in the header) survive step
  // changes, the active dot's width smoothly transitions (transition-all) and
  // the card resizes smoothly (useAnimatedHeight) as you move between steps —
  // only the inner content remounts and slides. Welcome shows no dots;
  // CREATING is a transient sub-state of the account step that isn't in
  // VISIBLE_STEPS, so the dots hide while the button reads "Creating account…".
  return (
    <StepTransitionProvider stepKey={step} direction={animationDirection}>
      <SetupShell>
        <SetupCard header={step === STEP.WELCOME ? null : <StepDots current={step} />}>
          {renderedStep}
        </SetupCard>
      </SetupShell>
    </StepTransitionProvider>
  );
}
