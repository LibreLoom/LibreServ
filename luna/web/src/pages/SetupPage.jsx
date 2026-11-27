import { cn } from "@libreloom/ui/lib/utils.js";
import { useState, useEffect, useCallback, useRef, useContext } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useReducedMotion } from "motion/react";
import { AlertCircle, ArrowRight, Check, ChevronLeft, Eye, EyeOff, Lock, X } from "lucide-react";
import PropTypes from "prop-types";
import { LunaMark } from "@libreloom/ui/components/common/ProductMark.jsx";
import { getJson, postJson, ApiError } from "../lib/api";
import { isValidDeviceToken, normalizeDeviceToken } from "../lib/deviceIdentity.js";
import {
  PASSWORD_POLICY_HINT,
  PASSWORD_FIELD_PLACEHOLDER,
  passwordChecks,
} from "@libreloom/ui/lib/passwordPolicy.js";
import {
  USERNAME_POLICY_HINT,
  displayNamePolicyError,
  isValidDisplayName,
  isValidUsername,
  usernamePolicyError,
} from "../lib/usernamePolicy";
import {
  hasSetupTokenInHash,
  readSetupTokenFromHash,
  stripSetupTokenFromHash,
} from "../lib/setupTokenParam.js";
import { useAuth } from "../context/AuthContext";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { useAnimatedHeight } from "@libreloom/ui/hooks/useAnimatedHeight.jsx";
import useSetupProgress from "../hooks/useSetupProgress";
import { StepTransitionContext } from "@libreloom/ui/components/setup/StepTransitionContext.js";
import { StepTransitionProvider } from "@libreloom/ui/components/setup/StepTransition.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import DotMatrixLoader from "@libreloom/ui/components/ui/DotMatrixLoader.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import useLabelErrorState from "@libreloom/ui/hooks/useLabelErrorState.js";
import PreflightStep from "../components/setup/PreflightStep.jsx";
import DiscoveryPaths from "../components/setup/DiscoveryPaths.jsx";
import TextLink from "../components/ui/TextLink";
import PasswordStrengthChecklist from "@libreloom/ui/components/common/PasswordStrengthChecklist.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import usePageTitle from "../hooks/usePageTitle.js";

// ─── Step constants ───────────────────────────────────────────────────────────
const STEP = {
  WELCOME:    "welcome",
  PREFLIGHT:  "preflight",
  ACCOUNT:    "account",
  NAME:       "name",
  DONE:       "done",
};

// Shared input style for the inverted (bg-secondary) setup card: a transparent
// field with a primary-toned border; text is primary (inverted to match the card).
// Same constant as Sol's SetupPage so the two wizards read identically.
const WIZARD_INPUT_CLASS =
  "w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150";

// ─── Full-screen shell (bg-primary = page background) ────────────────────────
function SetupShell({ children }) {
  return (
    <div data-slot="setup-page" className="min-h-screen flex flex-col items-center justify-center surface-primary px-4 py-12">
      {children}
    </div>
  );
}
SetupShell.propTypes = { children: PropTypes.node.isRequired };

// One-shot slide-in wrapper. Chrome can replay CSS animations on :focus / style
// recalculation while animation-name is still set, so we drop the animate-in /
// slide-in-from-*-pop classes after the entrance finishes. Remount via `key`
// (step or substep) to play again on the next transition.
const ONE_SHOT_SLIDE_MS = 300;

function OneShotSlide({ children, className = "", direction = "right", enabled = true }) {
  const [done, setDone] = useState(false);
  const reducedMotion = useReducedMotion();
  const animating = enabled && !done && !reducedMotion;

  // Timeout fallback matches ModalCard: animationend can be skipped (reduced
  // motion, jsdom) and must not leave animation-name live permanently.
  useEffect(() => {
    if (!animating) return undefined;
    const id = window.setTimeout(() => setDone(true), ONE_SHOT_SLIDE_MS);
    return () => window.clearTimeout(id);
  }, [animating]);

  return (
    <div
      data-slot="one-shot-slide"
      className={cn(
        className,
        animating && "animate-in duration-300",
        animating && (direction === "left" ? "slide-in-from-left-pop" : "slide-in-from-right-pop"),
      )}
      // backwards (not both): drop the transform after the slide so focused
      // inputs inside don't jump on a leftover compositing layer.
      style={animating ? { animationFillMode: "backwards" } : undefined}
      onAnimationEnd={(event) => {
        // Ignore bubbled animationend from children (fade-ins, etc.).
        if (event.target !== event.currentTarget) return;
        setDone(true);
      }}
    >
      {children}
    </div>
  );
}
OneShotSlide.propTypes = {
  children:  PropTypes.node.isRequired,
  className: PropTypes.string,
  direction: PropTypes.oneOf(["left", "right"]),
  enabled:   PropTypes.bool,
};

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
//
// While `loading`, the card holds its (invisible) content so it is already the
// size of the first step, and a dot-matrix wave fills it. When loading ends the
// wave fades out over the content, which cascades in on its own.
const LOADER_FADE_MS = 500;

function SetupCard({ children, className = "", header = null, loading = false }) {
  const { outerRef, innerRef } = useAnimatedHeight();
  const { key: tKey, direction } = useContext(StepTransitionContext);
  const [loaderGone, setLoaderGone] = useState(false);
  const reducedMotion = useReducedMotion();

  // Keep the loader mounted until its fade-out has finished.
  useEffect(() => {
    if (loading || reducedMotion) return undefined;
    const id = window.setTimeout(() => setLoaderGone(true), LOADER_FADE_MS);
    return () => window.clearTimeout(id);
  }, [loading, reducedMotion]);

  return (
    <div
      ref={outerRef}
      className="relative w-full max-w-md surface-secondary rounded-large-element shadow-[0_32px_80px_rgba(0,0,0,0.12)] overflow-hidden motion-safe:transition-[height] ease-[var(--motion-easing-emphasized-decelerate)]"
      style={{ transitionDuration: "var(--motion-duration-medium2)" }}
    >
      <div
        ref={innerRef}
        className={cn("px-10 py-10", loading && "invisible")}
        aria-hidden={loading || undefined}
        inert={loading || undefined}
      >
        {header}
        <OneShotSlide key={tKey} className={className} direction={direction}>
          {children}
        </OneShotSlide>
      </div>
      {(loading || (!reducedMotion && !loaderGone)) && (
        <div
          className={cn(
            "absolute inset-0 z-10 surface-secondary motion-safe:transition-opacity ease-out",
            loading ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
          style={{ transitionDuration: `${LOADER_FADE_MS}ms` }}
        >
          {/* Inset so the wave stays on the card and clear of its rounded edge. */}
          <div className="absolute inset-6">
            <DotMatrixLoader bare label="Loading setup" decorative={!loading} />
          </div>
        </div>
      )}
    </div>
  );
}
SetupCard.propTypes = {
  children:  PropTypes.node.isRequired,
  className: PropTypes.string,
  header:    PropTypes.node,
  loading:   PropTypes.bool,
};

// ─── Step progress dots (on the card, so use primary colors) ─────────────────
// The shared indicator across both products: a plain row of dots — active is
// a wider pill (smoothly stretched via transition-all, no entrance cascade,
// no breathe) — plus Sol's "N / M" step counter on the right.
// Shown on every step, including Welcome.
const VISIBLE_STEPS = [
  { id: STEP.WELCOME,    label: "Welcome" },
  { id: STEP.PREFLIGHT,  label: "System check" },
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
              ? "w-5 h-2 surface-primary"
              : i < idx
                ? "w-2 h-2 bg-primary/40"
                : "w-2 h-2 bg-primary/15"
          )}
          title={s.label}
          aria-label={s.label}
        />
      ))}
      <span className="ml-auto text-[11px] font-mono text-primary animate-in fade-in duration-300">
        {idx + 1} / {VISIBLE_STEPS.length}
      </span>
    </div>
  );
}
StepDots.propTypes = { current: PropTypes.string.isRequired };

// ─── Logo mark ────────────────────────────────────────────────────────────────
// Takes the card's text color, so it inverts with the setup card in both themes.
function LogoMark({ size = 64 }) {
  return <LunaMark size={size} />;
}
LogoMark.propTypes = { size: PropTypes.number };

// ─── STEP: Welcome ────────────────────────────────────────────────────────────
// Content-only: SetupPage renders the persistent shell (SetupShell + SetupCard
// with the dots header) around the current step, so the card and the dot row
// survive step changes and the active dot's width smoothly transitions.
//
// `cascade` is true once loading finishes: each element then fades up in turn.
// Until then the elements just hold their place (the card is invisible).
const CASCADE_STEP_MS = 90;

function cascadeProps(cascade, index) {
  if (!cascade) return { className: "", style: undefined };
  return {
    className: "animate-in fade-in slide-in-from-bottom-2 duration-500",
    style: { animationDelay: `${index * CASCADE_STEP_MS}ms`, animationFillMode: "backwards" },
  };
}

function WelcomeStep({ onBegin, cascade = false, advancing = false }) {
  const logo = cascadeProps(cascade, 1);
  const title = cascadeProps(cascade, 2);
  const lead = cascadeProps(cascade, 3);
  const begin = cascadeProps(cascade, 4);
  return (
    <div className="flex flex-col items-center text-center">
      <div className={cn("mb-10", logo.className)} style={logo.style}>
        <LogoMark size={120} />
      </div>

      <h1 className={cn("font-mono text-5xl font-normal text-primary mb-4", title.className)} style={title.style}>
        Welcome.
      </h1>

      <p className={cn("text-primary text-xl leading-[1.65] mb-12 max-w-[22rem]", lead.className)} style={lead.style}>
        Let&rsquo;s get Luna set up for you.
      </p>

      <div className={begin.className} style={begin.style}>
        <Button
          variant="primary"
          onClick={onBegin}
          loading={advancing}
          className="group px-9 py-4 font-mono hover:scale-[1.03]"
        >
          Begin setup
          <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
        </Button>
      </div>
    </div>
  );
}
WelcomeStep.propTypes = {
  onBegin: PropTypes.func.isRequired,
  cascade: PropTypes.bool,
  advancing: PropTypes.bool,
};



// ─── Password strength (same policy as Sol + lunad) ─────────────────────
// Acceptable = 12+ chars, a letter, and a digit. Symbols strengthen the bar but
// are NOT required — gating on them would reject passwords the backend accepts.
function strengthInfo(pw) {
  if (!pw) return null;
  return passwordChecks(pw);
}

/** @param {{ id: any, label: any, hint?: any, children: any, error?: any, shake?: any, loading?: boolean }} _ */
function FormField({ id, label, hint, children, error, shake, loading = false }) {
  const { labelError, containerRef } = useLabelErrorState(error, shake, { loading });
  return (
    <div ref={containerRef}>
      <label
        htmlFor={id}
        className={cn(
          "block text-primary font-sans text-sm text-left translate-x-5 mb-1 motion-safe:transition-colors duration-300",
          labelError && "text-error",
        )}
      >
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-primary mt-1.5 translate-x-5">{hint}</p>}
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

// ─── STEP: Account ────────────────────────────────────────────────────────────
// Focus is sent immediately to the visible text entry box on mount and
// on every substep transition.

function AccountStep({ hasAdmin, onContinue, deviceToken, offLan, deviceTokenSet = null }) {
  const { user, register, login } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    display_name:     "",
    username:         "",
    password:         "",
    confirm_password: "",
    device_token:    deviceToken,
  });
  const [showPw, setShowPw]         = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState(null);
  const [authSubStep, setAuthSubStep] = useState(0);
  const [authSubDir, setAuthSubDir]   = useState("right");
  // Luna says when this page is reached from outside the home network; only
  // then is the device token asked for. A token from the setup link fills it
  // in and skips the substep, and the substep comes back if Luna refuses it.
  const [tokenRefused, setTokenRefused] = useState(false);
  // Only animate field swaps after the user moves between substeps — not on
  // the initial mount (parent SetupCard already owns that entrance).
  const authSubAnimatedRef = useRef(false);
  const fieldInputRef = useRef(null);

  const pw       = form.password;
  const confirm  = form.confirm_password;
  const strength = strengthInfo(pw);
  const meetsPolicy = !!(strength?.ok);
  const displayNameOk = isValidDisplayName(form.display_name);
  const usernameOk  = isValidUsername(form.username);
  const confirmOk   = confirm === pw && pw !== "";
  // Off the home network with no token saved on Luna: there is nothing to type, so say where to set it up.
  const noDeviceToken = offLan && deviceTokenSet === false;
  const showDeviceTokenField = offLan && !noDeviceToken && (!deviceToken || tokenRefused);
  const usernameFieldError = usernamePolicyError(form.username);
  const displayNameFieldError = displayNamePolicyError(form.display_name);

  const setField = (name, value) => {
    setForm((f) => ({ ...f, [name]: value }));
    if (fieldError) setFieldError(null);
  };

  const authFields = [
    {
      id: "display_name",
      question: "What's your name?",
      hint: "Luna shows this name after you sign in. You can skip it.",
      name: "display_name",
      type: "text",
      placeholder: "e.g. Alex",
      autoComplete: "name",
      valid: displayNameOk,
      inlineError: displayNameFieldError,
    },
    {
      id: "username",
      question: "Pick a username",
      hint: "You sign in with this. Use 3 to 32 letters, numbers, dots, dashes, or underscores.",
      name: "username",
      type: "text",
      placeholder: "alex",
      autoComplete: "username",
      valid: usernameOk,
      // Show the rule as soon as they type something invalid — do not wait
      // until Create account fails at the last substep.
      inlineError: usernameFieldError,
    },
    {
      id: "password",
      question: "Choose a password",
      hint: PASSWORD_POLICY_HINT,
      name: "password",
      type: "password",
      placeholder: PASSWORD_FIELD_PLACEHOLDER,
      autoComplete: "new-password",
      valid: meetsPolicy,
      showStrength: true,
    },
    {
      id: "confirm_password",
      question: "Confirm your password",
      hint: "Type the same password again.",
      name: "confirm_password",
      type: "password",
      placeholder: "Re-enter your password",
      autoComplete: "new-password",
      valid: confirmOk,
    },
  ];
  if (showDeviceTokenField) {
    authFields.push({
      id: "device_token",
      question: "Device token",
      hint: "You are setting up from outside your home network, so Luna needs its device token. It is printed in the quick-start guide that came with your Luna.",
      name: "device_token",
      type: "text",
      placeholder: "7K4M-2Q9X-R8N3-6T5W-1PZH",
      autoComplete: "off",
      valid: isValidDeviceToken(form.device_token),
      inlineError: form.device_token.trim() && !isValidDeviceToken(form.device_token)
        ? "A device token has 20 letters and numbers."
        : null,
    });
  }

  const currentAuthField = authFields[authSubStep] || authFields[0];
  const isLastAuthSubStep = authSubStep === authFields.length - 1;
  const animateAuthSub = authSubAnimatedRef.current;

  const goSubNext = () => {
    haptic("selection");
    authSubAnimatedRef.current = true;
    setAuthSubDir("right");
    setAuthSubStep((s) => Math.min(s + 1, authFields.length - 1));
  };
  const goSubPrev = () => {
    haptic("selection");
    authSubAnimatedRef.current = true;
    setAuthSubDir("left");
    setAuthSubStep((s) => Math.max(s - 1, 0));
  };

  /** Jump back to the substep that owns a register/login failure. */
  const jumpToField = (fieldName) => {
    const idx = authFields.findIndex((f) => f.name === fieldName);
    if (idx < 0) return;
    authSubAnimatedRef.current = true;
    setAuthSubDir("left");
    setAuthSubStep(idx);
  };

  // Focus is sent immediately to the visible text entry box on mount and when
  // advancing between substeps.
  useEffect(() => {
    if (hasAdmin) return undefined;
    fieldInputRef.current?.focus?.();
  }, [authSubStep, hasAdmin]);

  const handleCreateAccount = async () => {
    if (submitting) return;
    // Final guard: never call register with a username/name lunad will reject.
    if (!usernameOk) {
      setFieldError(USERNAME_POLICY_HINT);
      jumpToField("username");
      return;
    }
    if (!displayNameOk) {
      setFieldError(displayNameFieldError || "That name is too long.");
      jumpToField("display_name");
      return;
    }
    setSubmitting(true);
    setFieldError(null);
    try {
      const displayName = form.display_name.trim() || form.username.trim();
      const created = await register(form.username.trim(), displayName, pw, offLan ? normalizeDeviceToken(form.device_token) || undefined : undefined);
      // Luna could not check the password against known breaches (no
      // internet, or the breach service is down). The account is created —
      // say so, so the first password is not an unchecked one by accident.
      if (created?.warning) {
        addToast({ type: "info", message: created.warning, duration: 10000 });
      }
      await login(form.username.trim(), pw);
      onContinue();
    } catch (err) {
      const message = err?.message || "Couldn't create your account. Try again.";
      setFieldError(message);
      // Luna refused the device token — reveal the field so it can be corrected.
      if (offLan && /token/i.test(message)) {
        setTokenRefused(true);
        authSubAnimatedRef.current = true;
        setAuthSubDir("right");
        setAuthSubStep(authFields.length - (showDeviceTokenField ? 1 : 0));
      } else {
        const lower = message.toLowerCase();
        if (lower.includes("username") || lower.includes("user name")) {
          jumpToField("username");
        } else if (lower.includes("password")) {
          jumpToField("password");
        } else if (lower.includes("name") && !lower.includes("user")) {
          jumpToField("display_name");
        }
      }
      setSubmitting(false);
    }
  };

  const handleSubSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    if (!currentAuthField.valid) {
      // Keep them on this field with a clear reason instead of advancing.
      if (currentAuthField.inlineError) {
        setFieldError(currentAuthField.inlineError);
      } else if (currentAuthField.name === "username") {
        setFieldError(USERNAME_POLICY_HINT);
      }
      return;
    }
    setFieldError(null);
    if (isLastAuthSubStep) {
      await handleCreateAccount();
    } else {
      goSubNext();
    }
  };

  // Luna already has an account — the wizard can't create another one.
  if (hasAdmin) {
    if (user) {
      const isAdmin = user.role === "admin";
      return (
        <div className="flex flex-col items-center text-center">
          <div className="mb-7 w-16 h-16 rounded-full border border-primary/20 flex items-center justify-center animate-in fade-in duration-300">
            <Check className="w-7 h-7 text-primary" strokeWidth={1.5} />
          </div>
          <h2 className="font-mono text-3xl font-normal text-primary mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-100">
            You&rsquo;re signed in
          </h2>
          <p className="text-primary text-sm leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
            Signed in as <InlinePill>{user.username}</InlinePill>
            {isAdmin
              ? ". You're an Admin on this Luna."
              : ". You're a Member. An Admin finishes setup and shares folders with you."}
          </p>
          <div className="mt-8 animate-in fade-in duration-300 delay-300">
            <Button
              variant="primary"
              onClick={() => {
                if (isAdmin) onContinue();
                else navigate("/");
              }}
              className="group px-9 py-4 font-mono hover:scale-[1.03]"
            >
              {isAdmin ? "Continue" : "Go to Home"}
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
        <h2 className="font-mono text-3xl font-normal text-primary mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-100">Sign in to continue</h2>
        <p className="text-primary text-sm leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
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
        <h2 className="font-mono text-3xl font-normal text-primary">Create your account</h2>
        {authSubStep === 0 && (
          <div className="mt-2 space-y-2">
            <p className="text-primary text-sm leading-relaxed font-sans">
              This is the first Admin account. An Admin manages people, drives, and settings.
            </p>
            <p className="text-primary text-sm leading-relaxed font-sans">
              Later, you can add people and choose which drives and folders each person can open.
            </p>
          </div>
        )}
      </div>

      {noDeviceToken ? (
        <PageNotice variant="warning" className="mb-6">
          This Luna has no device token. Set it up from the same network as Luna.
        </PageNotice>
      ) : null}

      {/* Substep progress */}
      <div className="w-full mb-8">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-xs font-mono text-primary">
            {authSubStep + 1} of {authFields.length}
          </span>
        </div>
        <div className="flex gap-1.5">
          {authFields.map((f, i) => (
            <div key={f.id} className="flex-1 h-1 rounded-full bg-primary/15 overflow-hidden">
              <div
                className="h-full surface-primary motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.05,0.7,0.1,1)]"
                style={{ width: i <= authSubStep ? "100%" : "0%" }}
              />
            </div>
          ))}
        </div>
      </div>

      <form onSubmit={handleSubSubmit} className="text-left">
        <ShakeTarget shake={fieldError}>
          <OneShotSlide
            key={`register-${authSubStep}`}
            enabled={animateAuthSub}
            direction={authSubDir}
          >
            <label
              htmlFor={currentAuthField.id}
              className="block font-mono text-xl text-primary mb-5 leading-snug translate-x-5"
            >
              {currentAuthField.question}
            </label>

            {(currentAuthField.type === "password") ? (
              <div className="relative">
                <input
                  ref={fieldInputRef}
                  id={currentAuthField.id}
                  name={currentAuthField.name}
                  type={showPw ? "text" : "password"}
                  autoComplete={currentAuthField.autoComplete}
                  placeholder={currentAuthField.placeholder}
                  value={form[currentAuthField.name]}
                  onChange={(e) => setField(currentAuthField.name, e.target.value)}
                  disabled={submitting}
                  autoFocus
                  className={cn(WIZARD_INPUT_CLASS, "pr-12")}
                />
                <button
                  type="button"
                  onClick={() => {
                    haptic("light");
                    setShowPw((v) => !v);
                  }}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-primary hover:text-primary motion-safe:transition-colors motion-safe:duration-150"
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            ) : (
              <input
                ref={fieldInputRef}
                id={currentAuthField.id}
                name={currentAuthField.name}
                type={currentAuthField.type}
                autoComplete={currentAuthField.autoComplete}
                placeholder={currentAuthField.placeholder}
                value={form[currentAuthField.name]}
                onChange={(e) => setField(currentAuthField.name, e.target.value)}
                disabled={submitting}
                autoFocus
                spellCheck={currentAuthField.name === "device_token" ? false : undefined}
                className={WIZARD_INPUT_CLASS}
                aria-invalid={Boolean(
                  (currentAuthField.name === "device_token" && fieldError) ||
                  currentAuthField.inlineError,
                )}
              />
            )}

            {/* Hide the short policy hint once the live strength checklist is showing —
                the ReqChips already cover length / letter / number. */}
            {currentAuthField.hint && !(currentAuthField.showStrength && strength) && !currentAuthField.inlineError && !(currentAuthField.name === "confirm_password" && confirm) && (
              <p className="mt-2.5 text-xs text-primary leading-relaxed">{currentAuthField.hint}</p>
            )}

            {currentAuthField.showStrength && strength && (
              <PasswordStrengthChecklist password={pw} />
            )}

            {currentAuthField.inlineError && (
              <p className="inline-block text-xs text-primary bg-error/20 border border-error/30 rounded-chip px-3 py-1 mt-2.5" role="alert">
                {currentAuthField.inlineError}
              </p>
            )}

            {currentAuthField.name === "confirm_password" && confirm && (
              <p
                className={`inline-flex items-center gap-1.5 text-xs text-primary border rounded-chip px-3 py-1 mt-2.5 ${
                  confirmOk ? "bg-success/20 border-success/30" : "bg-error/20 border-error/30"
                }`}
                role="status"
              >
                {confirmOk ? <Check className="w-3.5 h-3.5 text-success" /> : <X className="w-3.5 h-3.5 text-error" />}
                {confirmOk ? "Passwords match" : "Passwords don\u2019t match"}
              </p>
            )}
          </OneShotSlide>
        </ShakeTarget>

        {fieldError && fieldError !== currentAuthField.inlineError && (
          <div className="flex items-start gap-2.5 p-4 rounded-card border border-error/25 bg-error/10 mt-6 animate-in fade-in slide-in-from-bottom-1 duration-200">
            <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
            <p className="text-sm text-primary">{fieldError}</p>
          </div>
        )}

        <div className="flex items-center gap-3 mt-8">
          {authSubStep > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={goSubPrev}
              disabled={submitting}
              className="shrink-0 px-4 py-4"
              aria-label="Back"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            fullWidth
            loading={submitting && isLastAuthSubStep}
            disabled={!currentAuthField.valid || submitting}
            className="group py-4 font-mono hover:scale-[1.02]"
          >
            {isLastAuthSubStep ? (
              submitting ? "Creating account…" : "Create account"
            ) : (
              <>
                Continue
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
  deviceToken: PropTypes.string,
  offLan: PropTypes.bool,
  deviceTokenSet: PropTypes.bool,
};

// ─── STEP: Name ───────────────────────────────────────────────────────────────
function NameStep({ initialName, onFinish }) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const nameInputRef = useRef(null);

  useEffect(() => {
    nameInputRef.current?.focus?.();
  }, []);

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
        <h2 className="font-mono text-3xl font-normal text-primary">Name your Luna</h2>
        <p className="text-primary text-sm mt-2">
          You see this name when you open Luna. Give each Luna its own name.
        </p>
      </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <ShakeTarget shake={error}>
            <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 delay-75">
              <FormField id="luna_name" label="Name" hint="1-40 characters">
                <input
                  ref={nameInputRef}
                  id="luna_name"
                  type="text"
                  maxLength={40}
                  autoComplete="off"
                  placeholder="e.g. Family Luna"
                  value={name}
                  onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
                  disabled={saving}
                  required
                  autoFocus
                  className={WIZARD_INPUT_CLASS}
                />
              </FormField>
            </div>
          </ShakeTarget>

          {/* Inline error */}
          {error && (
            <div className="flex items-start gap-2.5 p-4 rounded-card border border-error/25 bg-error/10 animate-in fade-in slide-in-from-bottom-1 duration-200">
              <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
              <p className="text-sm text-primary">{error}</p>
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
              className="group py-4 font-mono hover:scale-[1.02]"
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
function DoneStep({ name, onGoDashboard }) {
  const buttonRef = useRef(null);

  useEffect(() => {
    haptic("success");
    buttonRef.current?.focus?.();
    const frame = requestAnimationFrame(() => {
      buttonRef.current?.focus?.();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const label = name || "Luna";
  return (
    <div className="flex flex-col items-center text-center">
      {/* Check circle */}
      <div className="mb-7 w-16 h-16 rounded-full border border-primary/20 flex items-center justify-center animate-in fade-in duration-300">
        <Check className="w-7 h-7 text-primary" strokeWidth={1.5} />
      </div>

      <h2 className="font-mono text-3xl font-normal text-primary mb-3 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-100">
        {label} is ready.
      </h2>
      <p className="text-primary text-sm leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
        Now plug in a USB drive. Luna does not change the drive until you tell it to.
      </p>

      {/* Discovery paths — where to find Luna after setup */}
      <DiscoveryPaths name={label} />

      <div className="mt-8 animate-in fade-in duration-300 delay-400">
        <Button
          ref={buttonRef}
          autoFocus
          variant="primary"
          onClick={() => {
            haptic("medium");
            onGoDashboard();
          }}
          className="group px-9 py-4 font-mono hover:scale-[1.03]"
        >
          Go to dashboard
          <ArrowRight className="w-4 h-4 motion-safe:transition-transform motion-safe:duration-200 group-hover:translate-x-0.5" />
        </Button>
      </div>
    </div>
  );
}
DoneStep.propTypes = {
  name: PropTypes.string,
  onGoDashboard: PropTypes.func.isRequired,
};

// ─── Root: SetupPage ──────────────────────────────────────────────────────────

// Linear order of the wizard's main steps, used to derive the slide direction
// (forward → slide from right, back → slide from left) on step change.
const STEP_ORDER = [
  STEP.WELCOME,
  STEP.PREFLIGHT,
  STEP.ACCOUNT,
  STEP.NAME,
  STEP.DONE,
];

export default function SetupPage() {
  usePageTitle("Set up");
  const navigate = useNavigate();
  const location = useLocation();
  const { user, refresh } = useAuth();
  // null until saved progress is loaded — avoids flashing Welcome over a resume.
  const [step, setStep] = useState(null);
  const [transition, setTransition] = useState({ step, direction: "right" });
  if (step !== transition.step) {
    setTransition({
      step,
      direction: STEP_ORDER.indexOf(step) < STEP_ORDER.indexOf(transition.step) ? "left" : "right",
    });
  }
  const [hasAdmin, setHasAdmin] = useState(false);
  const [deviceName, setDeviceName] = useState("Luna");
  const { saveProgress, flushProgress } = useSetupProgress();
  const progressRef = useRef(/** @type {{ step?: string, stepData?: Record<string, unknown> }} */ ({}));
  const savingRef = useRef(false);
  const [advancing, setAdvancing] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [offLan, setOffLan] = useState(false);
  const [deviceTokenSet, setDeviceTokenSet] = useState(null);
  const [deviceToken] = useState(() => readSetupTokenFromHash(location.hash));
  const consumedSetupTokenRef = useRef(false);

  // Read the device token before the wizard renders and remove it from the
  // visible URL immediately. Query-string secrets are stripped, never accepted.
  useEffect(() => {
    if (consumedSetupTokenRef.current) return;
    const hasTokenFragment = hasSetupTokenInHash(location.hash);
    const legacyParams = new URLSearchParams(location.search);
    const hasLegacyToken = legacyParams.has("token");
    legacyParams.delete("token");
    if (!hasTokenFragment && !hasLegacyToken) return;
    consumedSetupTokenRef.current = true;
    navigate(
      {
        pathname: location.pathname,
        search: legacyParams.toString() ? `?${legacyParams.toString()}` : "",
        hash: stripSetupTokenFromHash(location.hash),
      },
      { replace: true },
    );
  }, [location.hash, location.pathname, location.search, navigate]);

  // During setup, ask lunad to read pairing details from the installer USB magazine when needed.
  useEffect(() => {
    if (!hydrated) return;
    postJson("/api/v1/setup/fetch-mag", {}).catch(() => {});
  }, [hydrated]);

  // Whether an account already exists (decides if the account step creates or
  // signs in). Re-checked whenever the signed-in user changes.
  useEffect(() => {
    const request = new AbortController();
    getJson("/api/v1/auth/status", { signal: request.signal })
      .then((data) => {
        if (request.signal.aborted) return;
        setHasAdmin(Boolean(data?.has_admin));
        setOffLan(Boolean(data?.setup_off_lan));
        setDeviceTokenSet(typeof data?.device_token_set === "boolean" ? data.device_token_set : null);
      })
      .catch(() => { /* offline — the account step will surface the error */ });
    return () => request.abort();
  }, [user]);

  // Restore wizard position from the device so a refresh mid-setup continues
  // where the user left off (same behavior as Sol).
  useEffect(() => {
    const request = new AbortController();
    const { signal } = request;
    (async () => {
      try {
        const setup = await getJson("/api/v1/setup", { signal });
        if (signal.aborted) return;
        if (setup?.name) setDeviceName(setup.name);

        if (setup?.setup_completed) {
          navigate("/", { replace: true });
          return;
        }

        const savedStep = setup?.current_step;
        const savedData = setup?.step_data && typeof setup.step_data === "object"
          ? setup.step_data
          : {};
        progressRef.current = {
          step: savedStep || STEP.WELCOME,
          stepData: savedData,
        };

        let next = savedStep || STEP.WELCOME;
        if (next === STEP.WELCOME && savedData.preflight_passed) next = STEP.ACCOUNT;
        // A wizard saved before the phrase step was dropped resumes at naming.
        if (next === "phrase") next = STEP.NAME;
        if (!STEP_ORDER.includes(next)) next = STEP.WELCOME;
        // "done" is only shown after a successful finish in this session.
        // A stale/partial record should resume at naming.
        if (next === STEP.DONE) next = STEP.NAME;
        // Read the signed-in person fresh: the `user` captured on mount may be from before sign-in finished.
        if (next === STEP.NAME || (next === STEP.ACCOUNT && savedData.account_completed)) {
          const me = user || await getJson("/api/v1/auth/me", { signal }).catch(() => null);
          if (signal.aborted) return;
          if (me) next = STEP.NAME;
          else {
            const status = await getJson("/api/v1/auth/status", { signal }).catch(() => null);
            if (signal.aborted) return;
            if (status?.has_admin) next = STEP.ACCOUNT;
          }
        }
        setStep(next);
      } catch {
        // After the first account exists, setup reads are signed-in only. If an
        // admin exists but this browser isn't signed in, land on the account
        // step so they can sign in and finish — not Welcome.
        if (signal.aborted) return;
        const status = await getJson("/api/v1/auth/status", { signal }).catch(() => null);
        if (signal.aborted) return;
        setStep(status?.has_admin ? STEP.ACCOUNT : STEP.WELCOME);
      } finally {
        if (!signal.aborted) setHydrated(true);
      }
    })();
    return () => request.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resume once on mount
  }, [navigate]);

  useEffect(() => {
    const handler = (e) => {
      if (savingRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const advanceStep = useCallback(
    /** @param {string} nextStep @param {Record<string, unknown>} [stepData] */
    async (nextStep, stepData) => {
      if (savingRef.current) return;
      const data = stepData || progressRef.current.stepData || {};
      setSaveError(null);
      savingRef.current = true;
      setAdvancing(true);
      try {
        await saveProgress(nextStep, data);
      } catch (err) {
        // One retry covers a blip. If it fails again, say what Luna actually
        // said: a 4xx here is a real refusal (bad step, full disk), not a
        // connection problem, and "check your connection" would be a lie.
        try {
          await saveProgress(nextStep, data);
        } catch (retryErr) {
          const status = retryErr?.status ?? err?.status;
          const said = retryErr?.message || err?.message;
          // No status means the request never reached Luna.
          setSaveError(
            status && status >= 400 && status < 500 && said
              ? said
              : status
                ? "Luna couldn't save your setup progress. Try again."
                : "Luna couldn't save your setup progress. Check your connection and try again.",
          );
          return;
        }
      } finally {
        savingRef.current = false;
        setAdvancing(false);
      }
      progressRef.current = { step: nextStep, stepData: data };
      setStep(nextStep);
    },
    [saveProgress],
  );

  const handleBegin = useCallback(() => {
    const data = { ...(progressRef.current.stepData || {}), network_connected: true };
    advanceStep(STEP.PREFLIGHT, data);
  }, [advanceStep]);
  const handlePreflightPass = useCallback(() => {
    const data = { ...(progressRef.current.stepData || {}), preflight_passed: true };
    advanceStep(STEP.ACCOUNT, data);
  }, [advanceStep]);
  const handleAccountContinue = useCallback(() => {
    const data = { ...(progressRef.current.stepData || {}), account_completed: true };
    advanceStep(STEP.NAME, data);
  }, [advanceStep]);

  const handleFinish = useCallback(async (name) => {
    // Flush any in-flight progress save, then mark setup complete.
    await flushProgress();
    // Throws on failure so NameStep keeps its input and stays on the step.
    const saved = await postJson("/api/v1/setup", {
      name,
      setup_completed: true,
      current_step: STEP.DONE,
    });
    setDeviceName(saved?.name || name);
    // Refresh the auth context so RequireAuth sees setup_completed === true
    // and lets the post-setup navigation through.
    await refresh();
    setStep(STEP.DONE);
  }, [flushProgress, refresh]);

  // While loading, the card holds an invisible Welcome step (the usual first
  // step) so it is already the right size under the dot-matrix wave.
  const loading = !hydrated || step == null;
  const shownStep = loading ? STEP.WELCOME : step;

  let renderedStep;
  if (shownStep === STEP.WELCOME) {
    renderedStep = <WelcomeStep onBegin={handleBegin} cascade={!loading} advancing={advancing} />;
  } else if (shownStep === STEP.PREFLIGHT) {
    renderedStep = <PreflightStep onPass={handlePreflightPass} advancing={advancing} />;
  } else if (shownStep === STEP.ACCOUNT) {
    renderedStep = (
      <AccountStep
        hasAdmin={hasAdmin}
        onContinue={handleAccountContinue}
        deviceToken={deviceToken}
        offLan={offLan}
        deviceTokenSet={deviceTokenSet}
      />
    );
  } else if (shownStep === STEP.NAME) {
    renderedStep = <NameStep initialName={deviceName} onFinish={handleFinish} />;
  } else if (shownStep === STEP.DONE) {
    renderedStep = <DoneStep name={deviceName} onGoDashboard={() => navigate("/")} />;
  }

  // One persistent shell for the whole wizard. Because the SetupShell +
  // SetupCard (and thus the dot row in the header) survive step changes, the
  // active dot's width smoothly transitions (transition-all) and the card
  // resizes smoothly (useAnimatedHeight) as you move between steps — only the
  // inner content remounts and slides. Each step is content-only for this.
  return (
    <StepTransitionProvider stepKey={shownStep} direction={transition.direction}>
      <SetupShell>
        <SetupCard header={<StepDots current={shownStep} />} loading={loading}>
          {saveError && (
            <div className="mb-6 flex items-start gap-2.5 p-4 rounded-card border border-error/25 bg-error/10">
              <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
              <p className="text-sm text-primary">{saveError}</p>
            </div>
          )}
          {renderedStep}
        </SetupCard>
      </SetupShell>
    </StepTransitionProvider>
  );
}
