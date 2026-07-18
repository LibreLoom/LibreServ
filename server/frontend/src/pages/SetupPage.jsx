import { cn } from "@/lib/utils";
import { useState, useEffect, useCallback, useMemo, useRef, useContext } from "react";
import { useNavigate } from "react-router-dom";
import { Check, X, AlertCircle, Loader2, ArrowRight, Eye, EyeOff, Globe, AlertTriangle, Mail, Wifi, WifiOff, Shield, ArrowDown, ShieldCheck } from "lucide-react";
import PropTypes from "prop-types";
import api from "../lib/api";
import { getConnectivityStatus } from "../lib/network-api";
import DomainWizard from "../components/setup/DomainWizard";
import SmtpWizard from "../components/smtp/SmtpWizard";
import ExternalServicesStep from "../components/setup/ExternalServicesStep";
import ConfirmModal from "../components/cards/ConfirmModal";
import PreflightRemediation from "../components/setup/PreflightRemediation";
import { summarizeError } from "../lib/preflight-errors";
import useSetupProgress from "../hooks/useSetupProgress";
import { useAuth } from "../hooks/useAuth";
import { useAnimatedHeight } from "../hooks/useAnimatedHeight";
import { StepTransitionContext } from "../components/setup/StepTransitionContext";
import { StepTransitionProvider } from "../components/setup/StepTransition";
import { MfaSetupWizard } from "../components/profile/MfaCard";
import Button from "../components/ui/Button";
import Login from "./Login";

// ─── Step constants ───────────────────────────────────────────────────────────
const STEP = {
  SETUP_CODE:  "setup_code",
  WELCOME:      "welcome",
  PREFLIGHT:   "preflight",
  ACCOUNT:     "account",
  REMOTE_ACCESS: "remote_access",
  SMTP:             "smtp",
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
const VISIBLE_STEPS = [STEP.WELCOME, STEP.PREFLIGHT, STEP.ACCOUNT, STEP.REMOTE_ACCESS, STEP.SMTP, STEP.EXTERNAL_SERVICES, STEP.MFA, STEP.COMPLETE];

function StepDots({ current }) {
  const idx = VISIBLE_STEPS.indexOf(current);
  if (idx < 0) return null;
  return (
    <div className="flex items-center gap-2 mb-8">
      {VISIBLE_STEPS.map((s, i) => (
        <div
          className={cn("rounded-full motion-safe:transition-all motion-safe:duration-300", i === idx ? "w-5 h-2 bg-primary" : i < idx ? "w-2 h-2 bg-primary/40" : "w-2 h-2 bg-primary/15")}
        />
      ))}
      <span className="ml-auto text-[11px] font-mono tracking-wider text-primary/30">
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

// ─── Logo mark (inline SVG — currentColor, rendered on bg-secondary) ─────────
// On bg-secondary the outer circle fills with primary (white in light, black in dark).
function LogoMark({ size = 64 }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="none"
      width={size}
      height={size}
      className="text-primary"
      aria-hidden="true"
    >
      <ellipse cx="256" cy="256" rx="200" ry="200" fill="currentColor" />
      <rect x="146" y="168" width="220" height="176" rx="20" fill="var(--color-secondary)" />
      <rect x="162" y="154" width="188" height="20" rx="10" fill="var(--color-secondary)" opacity="0.55" />
      <rect x="174" y="196" width="164" height="112" rx="14" fill="currentColor" />

      <defs>
        <clipPath id="ls-faceplate">
          <rect x="174" y="196" width="164" height="112" rx="14"/>
        </clipPath>
        <clipPath id="ls-aboveFaceplate">
          <rect x="174" y="174" width="164" height="22" rx="10"/>
        </clipPath>
        <mask id="ls-weftOverOdd" x="174" y="196" width="164" height="112" maskUnits="userSpaceOnUse">
          <rect x="174" y="196" width="164" height="112" fill="black"/> {/* color-scan: ignore-line SVG mask requires black */}
          <rect x="186" y="196" width="16" height="112" fill="white"/> {/* color-scan: ignore-line SVG mask requires white */}
          <rect x="222" y="196" width="16" height="112" fill="white"/> {/* color-scan: ignore-line SVG mask requires white */}
          <rect x="258" y="196" width="16" height="112" fill="white"/> {/* color-scan: ignore-line SVG mask requires white */}
          <rect x="294" y="196" width="16" height="112" fill="white"/> {/* color-scan: ignore-line SVG mask requires white */}
        </mask>
        <mask id="ls-weftOverEven" x="174" y="196" width="164" height="112" maskUnits="userSpaceOnUse">
          <rect x="174" y="196" width="164" height="112" fill="black"/> {/* color-scan: ignore-line SVG mask requires black */}
          <rect x="204" y="196" width="16" height="112" fill="white"/> {/* color-scan: ignore-line SVG mask requires white */}
          <rect x="240" y="196" width="16" height="112" fill="white"/> {/* color-scan: ignore-line SVG mask requires white */}
          <rect x="276" y="196" width="16" height="112" fill="white"/> {/* color-scan: ignore-line SVG mask requires white */}
          <rect x="312" y="196" width="16" height="112" fill="white"/> {/* color-scan: ignore-line SVG mask requires white */}
        </mask>
      </defs>

      <g clipPath="url(#ls-aboveFaceplate)" fill="currentColor" opacity="0.7">
        <rect x="190" y="174" width="8" height="22" rx="3"/>
        <rect x="208" y="174" width="8" height="22" rx="3"/>
        <rect x="226" y="174" width="8" height="22" rx="3"/>
        <rect x="244" y="174" width="8" height="22" rx="3"/>
        <rect x="262" y="174" width="8" height="22" rx="3"/>
        <rect x="280" y="174" width="8" height="22" rx="3"/>
        <rect x="298" y="174" width="8" height="22" rx="3"/>
        <rect x="316" y="174" width="8" height="22" rx="3"/>
      </g>

      <rect x="174" y="196" width="164" height="112" rx="14" stroke="var(--color-secondary)" strokeWidth="5" />
      <g fill="currentColor" opacity="0.5">
        <rect x="352" y="207" width="6" height="18" rx="3"/>
        <rect x="352" y="231" width="6" height="18" rx="3"/>
        <rect x="352" y="255" width="6" height="18" rx="3"/>
        <rect x="352" y="279" width="6" height="18" rx="3"/>
      </g>

      <g clipPath="url(#ls-faceplate)" opacity="0.36">
        <rect x="182" y="204" width="148" height="14" rx="7" stroke="var(--color-secondary)" strokeWidth="4" />
        <rect x="182" y="290" width="148" height="14" rx="7" stroke="var(--color-secondary)" strokeWidth="4" />
      </g>

      <g clipPath="url(#ls-faceplate)">
        <path d="M 180 238 H 356" stroke="var(--color-secondary)" strokeWidth="8" strokeLinecap="round" opacity="0.42" />
        <path d="M 180 270 H 356" stroke="var(--color-secondary)" strokeWidth="8" strokeLinecap="round" opacity="0.4" />
      </g>

      <g clipPath="url(#ls-faceplate)" fill="var(--color-secondary)" opacity="1">
        <rect x="190" y="218" width="8" height="84" rx="3"/>
        <rect x="208" y="218" width="8" height="84" rx="3"/>
        <rect x="226" y="218" width="8" height="84" rx="3"/>
        <rect x="244" y="218" width="8" height="84" rx="3"/>
        <rect x="262" y="218" width="8" height="84" rx="3"/>
        <rect x="280" y="218" width="8" height="84" rx="3"/>
        <rect x="298" y="218" width="8" height="84" rx="3"/>
        <rect x="316" y="218" width="8" height="84" rx="3"/>
      </g>

      <g clipPath="url(#ls-faceplate)" mask="url(#ls-weftOverOdd)">
        <path d="M 180 238 H 356" stroke="var(--color-secondary)" strokeWidth="10" strokeLinecap="round" opacity="1" />
      </g>
      <g clipPath="url(#ls-faceplate)" mask="url(#ls-weftOverEven)">
        <path d="M 180 270 H 356" stroke="var(--color-secondary)" strokeWidth="10" strokeLinecap="round" opacity="1" />
      </g>

      <g fill="currentColor">
        <rect x="182" y="320" width="30" height="10" rx="3" opacity="0.72" />
        <rect x="218" y="320" width="30" height="10" rx="3" opacity="0.72" />
        <circle cx="312" cy="326" r="5" opacity="0.55" />
        <circle cx="328" cy="326" r="5" opacity="0.92" />
        <circle cx="346" cy="326" r="7" opacity="0.92" />
      </g>
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
        <div className="mb-10 flex h-36 w-36 items-center justify-center rounded-full border border-primary/12 bg-primary/6 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <LogoMark size={120} />
        </div>

        <h1 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3">
          Enter your setup code
        </h1>

        <p className="text-primary/42 text-base leading-relaxed mb-10 max-w-[20rem]">
          Enter the 6-character code from the card included with your device.
        </p>

        <div className="w-full mb-6">
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

        <p className="mt-9 text-xs text-primary/20">
          LibreServ &bull; Self-hosted cloud platform
        </p>
      </SetupCard>
    </SetupShell>
  );
}
SetupCodeStep.propTypes = {
  onCodeVerified: PropTypes.func.isRequired,
};

// ─── STEP: Welcome ────────────────────────────────────────────────────────────
function WelcomeStep({ onBegin }) {
  return (
    <SetupShell>
      <SetupCard className="flex flex-col items-center text-center">
        <div className="mb-10 flex h-36 w-36 items-center justify-center rounded-full border border-primary/12 bg-primary/6 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <LogoMark size={120} />
        </div>

        <h1 className="font-mono text-5xl font-normal text-primary tracking-tight mb-4">
          Welcome.
        </h1>

        <p className="text-primary/68 text-xl leading-[1.65] mb-5 max-w-[22rem]">
          It&rsquo;s great to see you here.
        </p>
        <p className="text-primary/42 text-base leading-relaxed mb-12 max-w-[20rem]">
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

        <p className="mt-9 text-xs text-primary/20">
          LibreServ &bull; Self-hosted cloud platform
        </p>
      </SetupCard>
    </SetupShell>
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
          <Loader2 className="w-3.5 h-3.5 text-primary/60 animate-spin" />
        ) : isOk ? (
          <Check className="w-3.5 h-3.5 text-primary/70" />
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
          <p className="text-xs text-primary/70 mt-0.5">
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
    <SetupShell>
      <SetupCard className="" header={<StepDots current={STEP.PREFLIGHT} />}>
        
        {/* Header */}
        <div className="mb-7">
          <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
            System check
          </h2>
          <p className="text-primary/50 text-sm mt-2">
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
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary/70 mt-5 mb-1 first:mt-0">
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
              <p className="text-sm text-primary/80">{error}</p>
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
            <p className="text-xs text-primary/50 animate-in fade-in duration-300 h-6">
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
      </SetupCard>
    </SetupShell>
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

function AccountStep({ onSuccess, onError }) {
  const [form, setForm] = useState({
    admin_username: "",
    admin_email:    "",
    admin_password: "",
  });
  const [showPw, setShowPw]         = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState(null);

  const pw       = form.admin_password;
  const strength = strengthInfo(pw);
  const isValid  =
    form.admin_username.trim() &&
    form.admin_email.trim() &&
    pw &&
    (strength?.score ?? 0) >= 3;

  const handleChange = (e) =>
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    setFieldError(null);
    try {
      const res = await api("/setup/complete", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(form),
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

  return (
    <SetupShell>
      <SetupCard className="" header={<StepDots current={STEP.ACCOUNT} />}>
        
        {/* Header */}
        <div className="mb-8">
          <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
            Create your account
          </h2>
          <p className="text-primary/50 text-sm mt-2">
            This will be the administrator account.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Username */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-75">
            <FormField id="admin_username" label="Username" hint="Used to sign in">
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
          </div>

          {/* Email */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-150">
            <FormField id="admin_email" label="Email" hint="For notifications and account recovery">
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
          </div>

          {/* Password */}
          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
            <FormField id="admin_password" label="Password">
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
                    <div className="flex gap-3 text-xs text-primary/70">
                      <span className={strength.hasLength  ? "text-primary/60" : ""}>12+ chars</span>
                      <span className={strength.hasLetter  ? "text-primary/60" : ""}>letters</span>
                      <span className={strength.hasDigit   ? "text-primary/60" : ""}>numbers</span>
                      <span className={strength.hasSpecial ? "text-primary/60" : ""}>symbols</span>
                    </div>
                  </div>
                </div>
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
      </SetupCard>
    </SetupShell>
  );
}
AccountStep.propTypes = {
  onSuccess: PropTypes.func.isRequired,
  onError:   PropTypes.func.isRequired,
};

// ─── STEP: Complete ───────────────────────────────────────────────────────────
function CompleteStep() {
  return (
    <SetupShell>
      <SetupCard className="flex flex-col items-center text-center" header={<StepDots current={STEP.COMPLETE} />}>
        
        {/* Check circle */}
        <div className="mb-7 w-16 h-16 rounded-full border border-primary/20 flex items-center justify-center animate-in fade-in duration-300">
          <Check className="w-7 h-7 text-primary" strokeWidth={1.5} />
        </div>

        <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-100">
          All done.
        </h2>
        <p className="text-primary/50 text-sm animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
          Taking you to your dashboard&hellip;
        </p>

        <div className="mt-8 animate-in fade-in duration-300 delay-300">
          <Loader2 className="w-5 h-5 animate-spin text-primary/25" />
        </div>
      </SetupCard>
    </SetupShell>
  );
}

// ─── STEP: Remote Access intro ───────────────────────────────────────────────────
function DomainIntroStep({ onStart, onSkip }) {
  const [showSkipModal, setShowSkipModal] = useState(false);

  return (
    <SetupShell>
      <SetupCard className="" header={<StepDots current={STEP.REMOTE_ACCESS} />}>
        
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full border border-primary/15 flex items-center justify-center">
              <Globe className="w-5 h-5 text-primary/60" />
            </div>
            <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
              Set up remote access
            </h2>
          </div>
          <p className="text-primary/50 text-sm leading-relaxed">
            Remote access lets you reach your apps from anywhere — not just from home. We'll help you set it up step by step.
          </p>
        </div>

        <div className="space-y-3 mb-8">
          {[
            { label: "Connect a domain name", desc: "A domain gives your apps a memorable address and enables HTTPS" },
            { label: "Configure your network", desc: "We'll detect your network type and set things up automatically" },
            { label: "Get a security certificate", desc: "Automatic HTTPS, for free, via Let\u2019s Encrypt" },
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-3 py-2">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center mt-0.5">
                <span className="text-[10px] text-primary/50 font-mono">{i + 1}</span>
              </div>
              <div>
                <p className="text-sm text-primary/80">{item.label}</p>
                <p className="text-xs text-primary/35">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Button
            variant="primary"
            fullWidth
            onClick={onStart}
            className="group py-4 font-mono tracking-wide hover:scale-[1.02]"
          >
            Set Up Remote Access
            <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
          </Button>
          <div className="text-center">
            <button
              onClick={() => setShowSkipModal(true)}
              className="text-primary/30 hover:text-primary/50 font-mono text-xs motion-safe:transition-colors motion-safe:duration-150"
            >
              Skip for now (Local access only)
            </button>
          </div>
        </div>
      </SetupCard>

      <ConfirmModal
        open={showSkipModal}
        onClose={() => setShowSkipModal(false)}
        onConfirm={onSkip}
        icon={AlertTriangle}
        title="Skip remote access setup?"
        message="Without remote access, your apps will only be reachable from this device. You can set this up later in Settings."
        variant="danger-undoable"
        confirmLabel="Skip anyway"
      />
    </SetupShell>
  );
}
DomainIntroStep.propTypes = {
  onStart: PropTypes.func.isRequired,
  onSkip:  PropTypes.func.isRequired,
};

// ─── STEP: NAT Detection ──────────────────────────────────────────────────────
function NatGroupBadge({ label, desc, icon: Icon, color }) {
  return (
    <div className={cn(`flex items-start gap-3 p-4 rounded-large-element border ${color}/20 bg-${color}/5`)}>
      <Icon className={cn(`w-5 h-5 text-${color} mt-0.5 flex-shrink-0`)} />
      <div>
        <p className={cn(`font-mono text-sm text-${color}`)}>{label}</p>
        <p className="text-xs text-primary/40 mt-1">{desc}</p>
      </div>
    </div>
  );
}
NatGroupBadge.propTypes = {
  label: PropTypes.string.isRequired,
  desc: PropTypes.string.isRequired,
  icon: PropTypes.elementType.isRequired,
  color: PropTypes.string.isRequired,
};

function NatDetectStep({ onContinue, onBack }) {
  const [detecting, setDetecting] = useState(true);
  const [natType, setNatType] = useState(null);
  const [connectivity, setConnectivity] = useState(null);
  const [detectError, setDetectError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getConnectivityStatus();
        if (cancelled) return;
        setNatType(data.nat_type || "unknown");
        setConnectivity(data);
        setDetecting(false);
      } catch (err) {
        if (cancelled) return;
        setDetectError(err.message || "Could not detect network type");
        setDetecting(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const natGroup = useMemo(() => {
    if (!natType) return "unknown";
    if (natType === "open") return "direct";
    if (["full_cone", "restricted", "port_restricted"].includes(natType)) return "router_required";
    if (["symmetric", "cgnat", "blocked"].includes(natType)) return "tunnel_needed";
    return "unknown";
  }, [natType]);

  const groupInfo = useMemo(() => {
    switch (natGroup) {
      case "direct":
        return {
          label: "Direct access",
          desc: "Your device is directly reachable from the internet. You can set up a domain and go.",
          icon: Wifi,
          color: "success",
        };
      case "router_required":
        return {
          label: "Router setup needed",
          desc: "Your internet connection goes through a router. We can try to configure it automatically, or you can set up port forwarding manually.",
          icon: Shield,
          color: "warning",
        };
      case "tunnel_needed":
        return {
          label: "Tunnel required",
          desc: "Your internet provider uses a shared connection (CGNAT) that blocks inbound access. A tunnel service like Cloudflare Tunnel can give you remote access instead.",
          icon: WifiOff,
          color: "error",
        };
      default:
        return {
          label: "Could not determine network type",
          desc: "We'll proceed with domain setup. You can troubleshoot later in Settings.",
          icon: AlertCircle,
          color: "accent",
        };
    }
  }, [natGroup]);

  if (detecting) {
    return (
      <SetupShell>
        <SetupCard className="" header={<StepDots current={STEP.REMOTE_ACCESS} />}>
                    <div className="flex flex-col items-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-primary/40 mb-4" />
            <p className="font-mono text-sm text-primary/60">Detecting your network type…</p>
            <p className="text-xs text-primary/30 mt-2">This takes a few seconds</p>
          </div>
        </SetupCard>
      </SetupShell>
    );
  }

  if (detectError) {
    return (
      <SetupShell>
        <SetupCard className="" header={<StepDots current={STEP.REMOTE_ACCESS} />}>
                    <div className="flex flex-col items-center py-8 text-center">
            <AlertCircle className="w-8 h-8 text-primary/40 mb-4" />
            <p className="font-mono text-sm text-primary/60 mb-2">Could not detect network type</p>
            <p className="text-xs text-primary/35 mb-6">{detectError}</p>
            <div className="flex flex-col gap-3 w-full">
              <Button
                variant="primary"
                fullWidth
                onClick={onContinue}
                className="group py-4 font-mono tracking-wide hover:scale-[1.02]"
              >
                Continue Anyway
                <ArrowRight className="w-4 h-4" />
              </Button>
              <button
                onClick={onBack}
                className="text-primary/30 hover:text-primary/50 font-mono text-xs motion-safe:transition-colors motion-safe:duration-150"
              >
                Go back
              </button>
            </div>
          </div>
        </SetupCard>
      </SetupShell>
    );
  }

  return (
    <SetupShell>
      <SetupCard className="" header={<StepDots current={STEP.REMOTE_ACCESS} />}>
        
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full border border-primary/15 flex items-center justify-center">
              <Wifi className="w-5 h-5 text-primary/60" />
            </div>
            <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
              Network detected
            </h2>
          </div>
          <p className="text-primary/50 text-sm leading-relaxed">
            We checked how your device connects to the internet. Here's what we found.
          </p>
        </div>

        <NatGroupBadge
          label={groupInfo.label}
          desc={groupInfo.desc}
          icon={groupInfo.icon}
          color={groupInfo.color}
        />

        {natGroup === "router_required" && connectivity?.upnp?.available && !connectivity?.upnp?.enabled && (
          <div className="mt-4 flex items-start gap-3 p-3 rounded-large-element bg-primary/5 border border-primary/10">
            <Shield className="w-4 h-4 text-primary/40 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-primary/50">
              Your router supports automatic port forwarding (UPnP). We can enable this later in Settings to make setup easier.
            </p>
          </div>
        )}

        {natGroup === "tunnel_needed" && (
          <div className="mt-4 flex items-start gap-3 p-3 rounded-large-element bg-primary/5 border border-primary/10">
            <ArrowDown className="w-4 h-4 text-primary/40 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-primary/50">
              You can still set up a domain for local HTTPS, but for access from outside your home, you'll need a tunnel. We'll guide you through that after domain setup.
            </p>
          </div>
        )}

        {connectivity?.public_ip && (
          <p className="mt-4 text-[10px] font-mono text-primary/20">
            Public IP: {connectivity.public_ip}
          </p>
        )}

        <div className="flex flex-col gap-3 mt-8">
          <Button
            variant="primary"
            fullWidth
            onClick={onContinue}
            className="group py-4 font-mono tracking-wide hover:scale-[1.02]"
          >
            {natGroup === "tunnel_needed" ? "Set Up Domain + Tunnel" : "Set Up Domain"}
            <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
          </Button>
          <button
            onClick={onBack}
            className="text-primary/30 hover:text-primary/50 font-mono text-xs motion-safe:transition-colors motion-safe:duration-150"
          >
            Go back
          </button>
        </div>
      </SetupCard>
    </SetupShell>
  );
}
NatDetectStep.propTypes = {
  onContinue: PropTypes.func.isRequired,
  onBack: PropTypes.func.isRequired,
};

// ─── STEP: SMTP intro ──────────────────────────────────────────────────────────
function SmtpIntroStep({ onStart, onSkip }) {
  const [showSkipModal, setShowSkipModal] = useState(false);

  return (
    <SetupShell>
      <SetupCard className="" header={<StepDots current={STEP.SMTP} />}>
        
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full border border-primary/15 flex items-center justify-center">
              <Mail className="w-5 h-5 text-primary/60" />
            </div>
            <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
              Connect email
            </h2>
          </div>
          <p className="text-primary/50 text-sm leading-relaxed">
            LibreServ needs to deliver emails — password resets, notifications, welcome messages. Since you control your own server, you choose the email provider that sends on your behalf.
          </p>
        </div>

        <div className="space-y-3 mb-8">
          {[
            { label: "Choose your email provider", desc: "Proton, Resend, Postmark, or bring your own" },
            { label: "Enter your credentials", desc: "We'll autofill the server details for you" },
            { label: "Test the connection", desc: "Verify everything works before saving" },
          ].map((item, i) => (
            <div key={i} className="flex items-start gap-3 py-2">
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center mt-0.5">
                <span className="text-[10px] text-primary/50 font-mono">{i + 1}</span>
              </div>
              <div>
                <p className="text-sm text-primary/80">{item.label}</p>
                <p className="text-xs text-primary/35">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Button
            variant="primary"
            fullWidth
            onClick={onStart}
            className="group py-4 font-mono tracking-wide hover:scale-[1.02]"
          >
            Start Email Setup
            <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
          </Button>
          <div className="text-center">
            <button
              onClick={() => setShowSkipModal(true)}
              className="text-primary/30 hover:text-primary/50 font-mono text-xs motion-safe:transition-colors motion-safe:duration-150"
            >
              Skip for now (Not recommended)
            </button>
          </div>
        </div>
      </SetupCard>

      <ConfirmModal
        open={showSkipModal}
        onClose={() => setShowSkipModal(false)}
        onConfirm={onSkip}
        icon={AlertTriangle}
        title="Skip email setup?"
        message="Without an email provider, LibreServ can't deliver password resets or notifications. You can add one later in Settings."
        variant="danger-undoable"
        confirmLabel="Skip anyway"
      />
    </SetupShell>
  );
}
SmtpIntroStep.propTypes = {
  onStart: PropTypes.func.isRequired,
  onSkip:  PropTypes.func.isRequired,
};

// ─── STEP: Error (fatal) ──────────────────────────────────────────────────────
function ErrorStep({ message }) {
  return (
    <SetupShell>
      <SetupCard className="flex flex-col items-center text-center">
        <div className="mb-6 w-14 h-14 rounded-full border border-error/25 bg-error/12 flex items-center justify-center">
          <AlertCircle className="w-6 h-6 text-error" strokeWidth={1.5} />
        </div>
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-primary/70 mb-3">
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
function MfaStep({ onComplete, smtpConfigured, onSessionExpired }) {
  return (
    <SetupShell>
      <SetupCard className="" header={<StepDots current={STEP.MFA} />}>

        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full border border-primary/15 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-primary/60" />
            </div>
            <h2 className="font-mono text-3xl font-normal text-primary tracking-tight">
              Enable MFA
            </h2>
          </div>
          <p className="text-primary/50 text-sm leading-relaxed">
            Two-factor authentication asks for a second check at sign-in — not just your password. As an admin, your account is at higher risk, so you need at least one method before you can finish setup.
          </p>
        </div>

        <MfaSetupWizard
          onComplete={onComplete}
          smtpConfigured={smtpConfigured}
          onSessionExpired={onSessionExpired}
        />
      </SetupCard>
    </SetupShell>
  );
}
MfaStep.propTypes = {
  onComplete: PropTypes.func.isRequired,
  smtpConfigured: PropTypes.bool.isRequired,
  onSessionExpired: PropTypes.func,
};

// ─── Root: SetupPage ──────────────────────────────────────────────────────────
const UNSAFE_SUB_STEPS = new Set(["connecting", "smtp_testing"]);

// Linear order of the wizard's main steps, used to derive the slide direction
// (forward → slide from right, back → slide from left) on step change. Steps
// not on the forward path (error/setup_code/creating) are treated as neutral.
const STEP_ORDER = [
  STEP.SETUP_CODE,
  STEP.WELCOME,
  STEP.PREFLIGHT,
  STEP.ACCOUNT,
  STEP.REMOTE_ACCESS,
  STEP.SMTP,
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
  const [showDomainWizard, setShowDomainWizard] = useState(false);
  const [showNatDetect, setShowNatDetect] = useState(false);
  const [showSmtpWizard, setShowSmtpWizard] = useState(false);
  const [initialSubStep, setInitialSubStep] = useState(null);
  const [initialStepData, setInitialStepData] = useState({});
  const { saveProgress, flushProgress } = useSetupProgress();
  const { refreshAuth } = useAuth();
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
    } catch {
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
          const step = saved.current_step;
          const savedData = saved.step_data || {};

          if (step === STEP.ACCOUNT) {
            if (savedData.account_completed) {
              setStep(STEP.REMOTE_ACCESS);
              saveProgress(STEP.REMOTE_ACCESS, "", { ...savedData });
              return;
            }
            setStep(STEP.ACCOUNT);
            setInitialStepData(savedData);
            progressRef.current = { step: STEP.ACCOUNT, subStep: "", stepData: savedData };
            return;
          }

          if (step === STEP.REMOTE_ACCESS) {
            if (savedData.remote_access_completed || savedData.remote_access_skipped) {
              setStep(STEP.SMTP);
              saveProgress(STEP.SMTP, "", { ...savedData });
              return;
            }
            if (saved.current_sub_step) {
              const sub = UNSAFE_SUB_STEPS.has(saved.current_sub_step) ? "token_input" : saved.current_sub_step;
              setStep(STEP.REMOTE_ACCESS);
              setInitialSubStep(sub);
              setInitialStepData(savedData);
              setShowDomainWizard(true);
              progressRef.current = { step: STEP.REMOTE_ACCESS, subStep: sub, stepData: savedData };
              if (sub !== saved.current_sub_step) {
                saveProgress(STEP.REMOTE_ACCESS, sub, savedData);
              }
              return;
            }
          }

          if (step === STEP.SMTP) {
            if (savedData.smtp_completed || savedData.smtp_skipped) {
              if (savedData.connect_activated || savedData.external_services_skipped) {
                setStep(STEP.MFA);
                saveProgress(STEP.MFA, "", { ...savedData });
              } else {
                setStep(STEP.EXTERNAL_SERVICES);
                saveProgress(STEP.EXTERNAL_SERVICES, "", { ...savedData });
              }
              return;
            }
            if (saved.current_sub_step) {
              const sub = UNSAFE_SUB_STEPS.has(saved.current_sub_step) ? "smtp_credentials" : saved.current_sub_step;
              setStep(STEP.SMTP);
              setInitialSubStep(sub);
              setInitialStepData(savedData);
              setShowSmtpWizard(true);
              progressRef.current = { step: STEP.SMTP, subStep: sub, stepData: savedData };
              if (sub !== saved.current_sub_step) {
                saveProgress(STEP.SMTP, sub, savedData);
              }
              return;
            }
            setStep(STEP.SMTP);
            setInitialStepData(savedData);
            progressRef.current = { step: STEP.SMTP, subStep: "", stepData: savedData };
            return;
          }

          if (step === STEP.MFA) {
            if (savedData.mfa_completed) {
              setStep(STEP.COMPLETE);
              saveProgress(STEP.COMPLETE, "", { ...savedData });
              return;
            }
            setStep(STEP.MFA);
            setInitialStepData(savedData);
            progressRef.current = { step: STEP.MFA, subStep: "", stepData: savedData };
            return;
          }

          setStep(step);
          setInitialStepData(savedData);
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
    advanceStep(STEP.ACCOUNT, "", data);
  }, [advanceStep]);

  const handleStartDomainWizard = useCallback(() => {
    setShowNatDetect(true);
    setInitialSubStep(null);
  }, []);

  const handleNatDetectContinue = useCallback(() => {
    setShowNatDetect(false);
    setShowDomainWizard(true);
    setInitialSubStep(null);
  }, []);

  const handleNatDetectBack = useCallback(() => {
    setShowNatDetect(false);
  }, []);

  const handleDomainComplete = useCallback(() => {
    const data = { ...(progressRef.current.stepData || {}), remote_access_completed: true };
    advanceStep(STEP.SMTP, "", data);
  }, [advanceStep]);

  const handleDomainSkip = useCallback(() => {
    const data = { ...(progressRef.current.stepData || {}), remote_access_skipped: true };
    advanceStep(STEP.SMTP, "", data);
  }, [advanceStep]);

  const handleStartSmtpWizard = useCallback(() => {
    setShowSmtpWizard(true);
  }, []);
  const handleSmtpComplete = useCallback(async () => {
    const data = { ...(progressRef.current.stepData || {}), smtp_completed: true };
    await advanceStep(STEP.EXTERNAL_SERVICES, "", data);
  }, [advanceStep]);
  const handleSmtpSkip = useCallback(async () => {
    const data = { ...(progressRef.current.stepData || {}), smtp_skipped: true };
    await advanceStep(STEP.EXTERNAL_SERVICES, "", data);
  }, [advanceStep]);

  const handleConnectActivate = useCallback(async (token) => {
    await api("/api/connect/activate", { method: "PUT", body: JSON.stringify({ token }) });
    const data = { ...(progressRef.current.stepData || {}), connect_activated: true };
    await advanceStep(STEP.MFA, "", data);
  }, [advanceStep]);

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
    advanceStep(STEP.REMOTE_ACCESS, "", data);
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

  if (step === null) {
    return (
      <SetupShell>
        <Loader2 className="w-8 h-8 animate-spin text-secondary/60" />
      </SetupShell>
    );
  }

  if (showLoginGate) {
    return (
      <SetupShell>
        <SetupCard className="">
          <Login
            embedded
            returnTo="/setup"
            onLoginSuccess={() => {
              setShowLoginGate(false);
              refreshAuth().catch(() => {});
            }}
          />
        </SetupCard>
      </SetupShell>
    );
  }

  if (step === STEP.ERROR) {
    return <ErrorStep message={error ?? "An unexpected error occurred."} />;
  }

  let renderedStep;
  if (step === STEP.SETUP_CODE) {
    renderedStep = <SetupCodeStep onCodeVerified={handleCodeVerified} />;
  } else if (step === STEP.WELCOME) {
    renderedStep = <WelcomeStep onBegin={handleBegin} />;
  } else if (step === STEP.PREFLIGHT) {
    renderedStep = <PreflightStep onPass={handlePreflightPass} />;
  } else if (step === STEP.REMOTE_ACCESS) {
    if (showNatDetect) {
      renderedStep = (
        <NatDetectStep
          onContinue={handleNatDetectContinue}
          onBack={handleNatDetectBack}
        />
      );
    } else if (showDomainWizard) {
      renderedStep = (
        <DomainWizard
          open={showDomainWizard}
          onComplete={handleDomainComplete}
          onSkip={handleDomainSkip}
          onDismiss={() => setShowDomainWizard(false)}
          initialSubStep={initialSubStep}
          initialStepData={initialStepData}
          saveProgress={saveProgress}
        />
      );
    } else {
      renderedStep = (
        <DomainIntroStep
          onStart={handleStartDomainWizard}
          onSkip={handleDomainSkip}
        />
      );
    }
  } else if (step === STEP.SMTP) {
    if (showSmtpWizard) {
      renderedStep = (
        <SmtpWizard
          open={showSmtpWizard}
          onComplete={handleSmtpComplete}
          onSkip={handleSmtpSkip}
          onDismiss={() => setShowSmtpWizard(false)}
          initialSubStep={initialSubStep}
          initialStepData={initialStepData}
          testRecipient={progressRef.current.stepData?.admin_email || ""}
          inSetup
          saveProgress={(stepName, subStep, data) => saveProgress(stepName, subStep, { ...progressRef.current.stepData, ...data })}
        />
      );
    } else {
      renderedStep = (
        <SmtpIntroStep
          onStart={handleStartSmtpWizard}
          onSkip={handleSmtpSkip}
        />
      );
    }
  } else if (step === STEP.EXTERNAL_SERVICES) {
    renderedStep = (
      <SetupShell>
        <SetupCard className="" header={<StepDots current={STEP.EXTERNAL_SERVICES} />}>
          <ExternalServicesStep
            onActivate={handleConnectActivate}
            onSkip={handleExternalServicesSkip}
          />
        </SetupCard>
      </SetupShell>
    );
  } else if (step === STEP.MFA) {
    renderedStep = (
      <MfaStep
        onComplete={handleMfaSuccess}
        smtpConfigured={progressRef.current.stepData?.smtp_completed === true}
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

  return (
    <StepTransitionProvider stepKey={step} direction={animationDirection}>
      {renderedStep}
    </StepTransitionProvider>
  );
}
