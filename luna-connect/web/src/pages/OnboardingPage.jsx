import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  Copy,
  Globe,
  HardDrive,
  Key,
  Loader2,
  MailOpen,
  Moon,
  Sparkles,
  Sun,
  User,
  X,
} from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import { api } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";
import { Button } from "../components/ui/button.jsx";
import ShakeTarget from "../components/ui/shake-target.jsx";
import { VerifyHumanCard } from "../components/VerifyHumanCard.jsx";
import { Input } from "../components/ui/input.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { useAnimatedHeight } from "../hooks/useAnimatedHeight.js";
import {
  meetsPasswordPolicy,
  PASSWORD_POLICY_HELPER,
  passwordChecks,
} from "../lib/passwordPolicy.js";
import { listenForEmailVerifiedCrossTab } from "../lib/emailVerifiedSync.js";
import { cn } from "../lib/utils.js";

const VERIFY_POLL_MS = 2000;

const OFFICIAL_STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "account", label: "Account" },
  { id: "code", label: "Code" },
  { id: "domain", label: "Name" },
  { id: "backup", label: "Backup" },
  { id: "done", label: "Done" },
];

const DIY_STEPS = [
  { id: "account", label: "Account" },
  { id: "card", label: "Confirm" },
  { id: "diy-code", label: "Code" },
  { id: "domain", label: "Name" },
  { id: "backup", label: "Backup" },
  { id: "done", label: "Done" },
];

const PROGRESS_KEY = "luna-connect-onboarding-progress";
const PUBLIC_ZONE = "luna.servers.libreloom.org";

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveProgress(data) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable */
  }
}

function clearProgress() {
  try {
    localStorage.removeItem(PROGRESS_KEY);
  } catch {
    /* storage unavailable */
  }
}

function emailOk(email) {
  return /^\S+@\S+\.\S+$/.test(email.trim());
}

const STRENGTH_LABEL = ["", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_COLOR = ["", "bg-error", "bg-warning", "bg-warning", "bg-success"];
const STRENGTH_TEXT = ["", "text-error", "text-warning", "text-warning", "text-success"];

/** @param {{ score: number }} props */
function PasswordStrengthBar({ score }) {
  return (
    <div className="flex gap-1 mt-2.5" aria-hidden="true">
      {[1, 2, 3, 4].map((lvl) => (
        <div
          key={lvl}
          className={cn(
            "h-1 flex-1 rounded-full motion-safe:transition-all motion-safe:duration-300",
            lvl <= score ? STRENGTH_COLOR[score] : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

/** A single password requirement chip: green check when met, muted X when missing. */
/** @param {{ ok: boolean, label: string }} props */
function ReqChip({ ok, label }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono text-xs motion-safe:transition-colors motion-safe:duration-200",
        ok ? "text-success" : "text-muted-foreground",
      )}
    >
      {ok ? <Check className="w-3 h-3" aria-hidden="true" /> : <X className="w-3 h-3" aria-hidden="true" />}
      {label}
    </span>
  );
}

/** Live checklist + strength bar — mirrors LibreServ / Luna setup. */
/** @param {{ password: string }} props */
function PasswordRequirements({ password }) {
  const strength = passwordChecks(password);
  if (!password) return null;
  return (
    <div className="mt-1" aria-live="polite">
      <PasswordStrengthBar score={strength.score} />
      <div className="flex items-center justify-between mt-1.5">
        <p className={cn("text-xs font-mono", STRENGTH_TEXT[strength.score])}>
          {STRENGTH_LABEL[strength.score]}
        </p>
        <p className={cn("text-xs font-mono", strength.ok ? "text-success" : "text-muted-foreground")}>
          {strength.ok ? "✓ Acceptable" : "Not strong enough yet"}
        </p>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
        <ReqChip ok={strength.hasLength} label="12+ chars" />
        <ReqChip ok={strength.hasLetter} label="letters" />
        <ReqChip ok={strength.hasDigit} label="numbers" />
        <ReqChip ok={strength.hasSpecial} label="symbols" />
      </div>
    </div>
  );
}

function pathFromLocation(pathname) {
  if (pathname === "/diyonboarding" || pathname === "/register") return "diy";
  return "official";
}

function progressIndex(stepId, path) {
  const steps = path === "diy" ? DIY_STEPS : OFFICIAL_STEPS;
  const map = {
    welcome: "welcome",
    account: "account",
    verify: "account",
    card: "card",
    "diy-code": "diy-code",
    code: "code",
    bind: "diy-code",
    domain: "domain",
    name: "domain",
    backup: "backup",
    copies: "backup",
    done: "done",
  };
  const mapped = map[stepId] || (path === "diy" ? "account" : "welcome");
  const idx = steps.findIndex((s) => s.id === mapped);
  return idx < 0 ? 0 : idx;
}

function ProgressBar({ stepId, path }) {
  const steps = path === "diy" ? DIY_STEPS : OFFICIAL_STEPS;
  const step = progressIndex(stepId, path);
  return (
    <div className="flex items-center justify-center pt-10 pb-8 px-4" role="list" aria-label="Setup progress">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center" role="listitem">
          <div className="flex flex-col items-center gap-2">
            <div
              className={cn(
                "relative flex items-center justify-center w-9 h-9 rounded-full text-xs font-mono motion-safe:transition-all motion-safe:duration-300",
                i < step
                  ? "bg-foreground text-background"
                  : i === step
                    ? "bg-foreground text-background scale-110 shadow-[0_0_0_5px_var(--ring-soft)]"
                    : "bg-muted text-muted-foreground",
              )}
              aria-current={i === step ? "step" : undefined}
            >
              {i < step ? (
                <Check className="w-4 h-4 animate-check-pop" />
              ) : (
                <span className={cn(i === step && "animate-fade-in")}>{i + 1}</span>
              )}
            </div>
            <span
              className={cn(
                "hidden sm:block text-[11px] font-mono motion-safe:transition-colors motion-safe:duration-300",
                i === step ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className="relative w-6 sm:w-12 h-0.5 mx-2 mb-0 sm:mb-6 bg-muted overflow-hidden rounded-full">
              <div
                className="absolute inset-y-0 left-0 bg-foreground motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.05,0.7,0.1,1)]"
                style={{ width: i < step ? "100%" : "0%" }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div className="rounded-large-element bg-error/10 border-2 border-error/30 p-4 flex items-start gap-3 mb-8 animate-fade-in-up">
      <X className="w-4 h-4 text-error mt-0.5 shrink-0" />
      <p className="text-sm text-error flex-1 leading-relaxed">{error}</p>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="text-error/60 hover:text-error motion-safe:transition-colors" aria-label="Dismiss error">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

function StepShell({ icon: Icon, title, children }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-6 animate-step-icon">
        <Icon size={26} className="text-foreground" strokeWidth={1.75} />
      </div>
      <h1 className="font-mono text-[1.75rem] leading-snug font-normal text-card-foreground tracking-tight mb-3 text-balance">
        {title}
      </h1>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

function resumeStepFromServer(path, serverStep, saved) {
  if (saved?.path === path && saved?.step) return saved.step;
  const step = (serverStep || "").trim();
  if (!step || step === "done") return path === "diy" ? "account" : "welcome";
  if (step === "name" || step === "copies") return step === "name" ? "domain" : "backup";
  if (step === "verify") return "account";
  if (path === "diy" && (step === "code" || step === "oss-code" || step === "bind")) return "diy-code";
  if (path === "official" && step === "bind") return "code";
  return step;
}

function stepAfterBind(account, path) {
  if (account?.onboarding_hostname) return "backup";
  const resumed = resumeStepFromServer(path, account?.onboarding_step, null);
  if (resumed === "done") return "done";
  if (resumed === "backup") return "backup";
  return "domain";
}

export default function OnboardingPage() {
  const {
    isAuthenticated,
    register,
    login,
    me,
    refresh,
    updateAccountEmail,
  } = useAuth();
  const { toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const path = pathFromLocation(location.pathname);
  const saved = useRef(loadProgress());

  const [step, setStep] = useState(() => {
    const local = saved.current?.path === path ? saved.current : null;
    if (path === "diy") {
      const resumed = resumeStepFromServer("diy", null, local);
      return resumed === "welcome" ? "account" : resumed || "account";
    }
    return resumeStepFromServer("official", null, local) || "welcome";
  });
  const [direction, setDirection] = useState("right");
  const [error, setError] = useState("");
  const { outerRef, innerRef } = useAnimatedHeight();

  const [code, setCode] = useState(saved.current?.code || "");
  // Prefill from the signed-in account on first paint when available; later seeding is step-entry only.
  const [email, setEmail] = useState(() => saved.current?.email || me?.email || "");
  const accountEmailVisitSeededRef = useRef(false);
  const [password, setPassword] = useState("");
  const [name, setName] = useState(saved.current?.name || "");
  const [diyCode, setDiyCode] = useState(saved.current?.diyCode || "");
  const [deviceId, setDeviceId] = useState(saved.current?.deviceId || "");
  const [hostname, setHostname] = useState(saved.current?.hostname || "");
  const [setupSecret, setSetupSecret] = useState(saved.current?.setupSecret || "");
  const [loading, setLoading] = useState(false);
  const [isLoginMode, setIsLoginMode] = useState(false);
  const [authSubStep, setAuthSubStep] = useState(0);
  const [authSubDir, setAuthSubDir] = useState("right");
  const [copied, setCopied] = useState("");
  const [checkingVerification, setCheckingVerification] = useState(false);
  const [resendState, setResendState] = useState("idle");
  const [cooldown, setCooldown] = useState(0);
  const verifyAdvanceLock = useRef(false);

  const emailVerified = Boolean(me?.email_verified);

  const goTo = useCallback((next, dir = "right") => {
    setDirection(dir);
    setStep(next);
  }, []);

  const seedFromOnboardingAccount = useCallback((account) => {
    if (!account) return;
    if (account.onboarding_device_id) setDeviceId(account.onboarding_device_id);
    if (account.onboarding_hostname) {
      setHostname(account.onboarding_hostname);
      const sub = account.onboarding_hostname.split(".")[0];
      if (sub) setName(sub);
    }
    if (account.onboarding_setup_secret) setSetupSecret(account.onboarding_setup_secret);
  }, []);

  const shouldSkipCodeEntry = useCallback((account) => {
    return Boolean(account?.has_bound_device || account?.skip_code_entry);
  }, []);

  const persistServerProgress = useCallback(
    async (nextStep) => {
      if (!isAuthenticated || !emailVerified) return;
      try {
        await api("/api/v1/onboarding/progress", {
          method: "POST",
          body: JSON.stringify({ path, step: nextStep }),
        });
      } catch {
        /* local progress still saved */
      }
    },
    [isAuthenticated, emailVerified, path],
  );

  useEffect(() => {
    if (step === "welcome" && !email && !code) return;
    saveProgress({
      step,
      path,
      code,
      email,
      name,
      diyCode,
      deviceId,
      hostname,
      setupSecret,
    });
  }, [step, path, code, email, name, diyCode, deviceId, hostname, setupSecret]);

  useEffect(() => {
    if (step === "welcome" || step === "account" || step === "verify") return;
    persistServerProgress(step);
  }, [step, persistServerProgress]);

  useEffect(() => {
    if (!isAuthenticated || !me) return;
    if (me.onboarding_path && me.onboarding_path !== path) return;

    seedFromOnboardingAccount(me);

    const codeSteps = ["code", "diy-code", "bind"];
    const atDefaultEntry = step === (path === "diy" ? "account" : "welcome");

    if (shouldSkipCodeEntry(me) && codeSteps.includes(step)) {
      goTo(stepAfterBind(me, path));
      return;
    }

    if (!me.onboarding_step || me.onboarding_step === "done") return;
    const resumed = resumeStepFromServer(path, me.onboarding_step, null);
    if (!resumed || resumed === step) return;
    const shouldReconcile =
      atDefaultEntry ||
      (codeSteps.includes(step) && resumed !== step) ||
      (step === "domain" && resumed === "backup");
    if (shouldReconcile) {
      goTo(resumed);
    }
    // Reconcile once when auth/me loads; avoid fighting mid-flow navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, me?.onboarding_step, me?.onboarding_path, me?.has_bound_device, me?.skip_code_entry]);

  // Prefill the change-email field once when entering the account step — never on empty edits.
  useEffect(() => {
    if (step !== "account") {
      accountEmailVisitSeededRef.current = false;
      return;
    }
    if (accountEmailVisitSeededRef.current) return;
    if (!isAuthenticated || emailVerified || !me?.email) return;
    accountEmailVisitSeededRef.current = true;
    setEmail((current) => current || me.email);
  }, [step, isAuthenticated, emailVerified, me?.email]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function bindDevice(value) {
    const res = await api("/api/v1/devices/bind", {
      method: "POST",
      body: JSON.stringify({ code: value }),
    });
    if (res.device_id) setDeviceId(res.device_id);
    return res;
  }

  async function mintDiyToken() {
    const minted = await api("/api/v1/account/diy-token", { method: "POST", body: "{}" });
    setDiyCode(minted.code);
    setCode(minted.code);
    if (minted.device_id) setDeviceId(minted.device_id);
    goTo("diy-code");
  }

  async function finishDiyVerify(paymentMethodId) {
    const body = paymentMethodId
      ? JSON.stringify({ payment_method_id: paymentMethodId })
      : "{}";
    await api("/api/v1/account/verify-human", { method: "POST", body });
    await refresh();
    await mintDiyToken();
  }

  async function afterDiyAccount(account) {
    const current = account || me;
    if (shouldSkipCodeEntry(current)) {
      seedFromOnboardingAccount(current);
      goTo(stepAfterBind(current, path));
      return;
    }
    if (current?.human_verified) {
      await mintDiyToken();
      return;
    }
    if (stripeLooksConfigured(current)) {
      goTo("card");
      return;
    }
    await finishDiyVerify();
  }

  async function afterOfficialAccount() {
    const account = await refresh();
    if (shouldSkipCodeEntry(account)) {
      seedFromOnboardingAccount(account);
      goTo(stepAfterBind(account, path));
      return;
    }
    goTo("code");
  }

  async function continueAfterVerification(account) {
    if (path === "diy") {
      await afterDiyAccount(account);
      return;
    }
    await afterOfficialAccount();
  }

  /**
   * Leave the inbox-wait step once email is confirmed.
   * Refresh from the server first (no optimistic mark) so polling does not
   * re-run this effect mid-flight and cancel the advance.
   */
  async function advancePastVerify() {
    if (verifyAdvanceLock.current) return;
    verifyAdvanceLock.current = true;
    setError("");
    try {
      const account = await refresh();
      if (!account?.email_verified) {
        verifyAdvanceLock.current = false;
        return;
      }
      await continueAfterVerification(account);
    } catch (err) {
      verifyAdvanceLock.current = false;
      throw err;
    }
  }

  // Poll / auto-advance off verify. Also runs when already verified (Back to Setup).
  useEffect(() => {
    if (step !== "verify") {
      verifyAdvanceLock.current = false;
      return undefined;
    }
    let cancelled = false;

    const checkVerified = async () => {
      if (cancelled || verifyAdvanceLock.current) return;
      try {
        const status = await api("/api/v1/account/verification-status");
        if (cancelled || !status.email_verified) return;
        await advancePastVerify();
      } catch {
        /* keep waiting */
      }
    };

    if (emailVerified) {
      advancePastVerify().catch((err) => {
        if (!cancelled) {
          setError(err.message || "Could not continue. Try again.");
        }
      });
      return () => {
        cancelled = true;
      };
    }

    const pollWhenVisible = () => {
      if (document.visibilityState === "visible") checkVerified();
    };

    checkVerified();
    const timer = setInterval(pollWhenVisible, VERIFY_POLL_MS);
    const stopCrossTab = listenForEmailVerifiedCrossTab(checkVerified);
    document.addEventListener("visibilitychange", pollWhenVisible);
    window.addEventListener("focus", pollWhenVisible);

    return () => {
      cancelled = true;
      clearInterval(timer);
      stopCrossTab();
      document.removeEventListener("visibilitychange", pollWhenVisible);
      window.removeEventListener("focus", pollWhenVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, emailVerified, refresh]);

  const authFields = isLoginMode
    ? [
        {
          id: "onb-email",
          question: "What's your email address?",
          hint: "The one you used for Luna Connect.",
          value: email,
          setValue: setEmail,
          type: "email",
          placeholder: "you@example.com",
          autoComplete: "username",
          valid: emailOk(email),
        },
        {
          id: "onb-password",
          question: "And your password?",
          value: password,
          setValue: setPassword,
          type: "password",
          placeholder: "Your password",
          autoComplete: "current-password",
          valid: password.length > 0,
        },
      ]
    : [
        {
          id: "onb-email",
          question: "What's your email address?",
          hint: "This is how you sign in to Luna Connect. It is separate from the login you will create on Luna itself.",
          value: email,
          setValue: setEmail,
          type: "email",
          placeholder: "you@example.com",
          autoComplete: "username",
          valid: emailOk(email),
        },
        {
          id: "onb-password",
          question: "Choose a password",
          hint: PASSWORD_POLICY_HELPER,
          value: password,
          setValue: setPassword,
          type: "password",
          placeholder: "Password",
          autoComplete: "new-password",
          valid: meetsPasswordPolicy(password),
          showPasswordRequirements: true,
        },
      ];

  const currentAuthField = authFields[authSubStep] || authFields[0];
  const isLastAuthSubStep = authSubStep === authFields.length - 1;

  const handleAuth = async (e) => {
    e.preventDefault();
    if (!currentAuthField.valid || loading) return;
    if (!isLastAuthSubStep) {
      if (!isLoginMode && authSubStep === 0) {
        setError("");
        setLoading(true);
        try {
          await api("/api/v1/account/check-email", {
            method: "POST",
            body: JSON.stringify({ email: email.trim() }),
          });
          setAuthSubDir("right");
          setAuthSubStep((s) => s + 1);
        } catch (err) {
          setError(err.message || "Could not continue. Check your details and try again.");
        } finally {
          setLoading(false);
        }
        return;
      }
      setAuthSubDir("right");
      setAuthSubStep((s) => s + 1);
      return;
    }
    setError("");
    setLoading(true);
    try {
      const account = isLoginMode
        ? await login(email.trim(), password)
        : await register(email.trim(), password);
      if (!account?.email_verified) {
        goTo("verify");
        return;
      }
      await continueAfterVerification(account);
    } catch (err) {
      setError(err.message || "Could not continue. Check your details and try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (label, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setError("Could not copy. Select the text and copy it yourself.");
    }
  };

  const handleBack = () => {
    setError("");
    if (step === "welcome" || (path === "diy" && step === "account" && authSubStep === 0)) {
      if (isAuthenticated) navigate("/");
      return;
    }
    if (step === "account" && authSubStep > 0) {
      setAuthSubDir("left");
      setAuthSubStep((s) => s - 1);
      return;
    }
    const officialBack = {
      account: "welcome",
      verify: "account",
      code: "account",
      domain: "code",
      backup: "domain",
      done: "backup",
    };
    const diyBack = {
      account: "account",
      verify: "account",
      card: "account",
      "diy-code": "account",
      domain: "diy-code",
      backup: "domain",
      done: "backup",
    };
    const back = path === "diy" ? diyBack : officialBack;
    goTo(back[step] || (path === "diy" ? "account" : "welcome"), "left");
  };

  const renderWelcome = () => (
    <StepShell icon={Sparkles} title="Set up your Luna">
      <div className="space-y-2 mb-10 text-left">
        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
          Using Luna Connect is the recommended way to set up Luna.
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
          If you wish to complete setup without Luna Connect, please follow those instructions in the quick-start guide instead.
        </p>
      </div>
      <Button
        size="lg"
        className="w-full"
        onClick={() => {
          setAuthSubStep(0);
          goTo("account");
        }}
      >
        Get Started <ArrowRight className="w-5 h-5" />
      </Button>
    </StepShell>
  );

  const renderAccount = () => (
    <StepShell
      icon={User}
      title={isLoginMode ? "Welcome back" : path === "diy" ? "Set up your own hardware" : "Create your account"}
    >
      <div className="w-full mb-10">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-xs font-mono text-muted-foreground">
            {authSubStep + 1} of {authFields.length}
          </span>
          <button
            type="button"
            onClick={() => {
              setIsLoginMode(!isLoginMode);
              setError("");
              setAuthSubStep(0);
              setAuthSubDir("left");
            }}
            className="text-xs text-muted-foreground hover:text-card-foreground underline underline-offset-4 motion-safe:transition-colors"
          >
            {isLoginMode ? "Need an account? Register" : "Already have an account? Sign in"}
          </button>
        </div>
        <div className="flex gap-1.5">
          {authFields.map((f, i) => (
            <div key={f.id} className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-foreground motion-safe:transition-[width] motion-safe:duration-500"
                style={{ width: i <= authSubStep ? "100%" : "0%" }}
              />
            </div>
          ))}
        </div>
      </div>
      <form onSubmit={handleAuth} className="w-full text-left">
        <ShakeTarget shake={error}>
          <div
            key={`${isLoginMode ? "login" : "register"}-${authSubStep}`}
            className={cn(authSubDir === "left" ? "slide-in-from-left-pop" : "slide-in-from-right-pop")}
            style={{ animationDuration: "300ms", animationFillMode: "both" }}
          >
            <label htmlFor={currentAuthField.id} className="block font-mono text-xl text-card-foreground mb-5 leading-snug">
              {currentAuthField.question}
            </label>
            <Input
              id={currentAuthField.id}
              type={currentAuthField.type}
              value={currentAuthField.value}
              onChange={(e) => currentAuthField.setValue(e.target.value)}
              placeholder={currentAuthField.placeholder}
              autoComplete={currentAuthField.autoComplete}
              autoFocus
            />
            {currentAuthField.hint && (
              <p className="mt-2.5 text-xs text-muted-foreground leading-relaxed">{currentAuthField.hint}</p>
            )}
            {currentAuthField.showPasswordRequirements && (
              <PasswordRequirements password={currentAuthField.value} />
            )}
          </div>
        </ShakeTarget>
        <Button
          type="submit"
          size="lg"
          className="w-full mt-8"
          loading={loading}
          disabled={!currentAuthField.valid}
        >
          {isLastAuthSubStep ? (isLoginMode ? "Sign in" : "Create account") : "Continue"}
          <ArrowRight className="w-4 h-4" />
        </Button>
      </form>
    </StepShell>
  );

  const renderSignedInAccount = () => {
    if (!emailVerified) {
      return (
        <StepShell icon={User} title="Change your email address">
          <p className="text-muted-foreground text-sm leading-relaxed mb-6 text-pretty">
            We need to verify your email before setup continues. Fix the address here if there is a typo.
          </p>
          <form
            className="space-y-4 text-left"
            onSubmit={async (event) => {
              event.preventDefault();
              const nextEmail = email.trim();
              if (!emailOk(nextEmail)) {
                setError("Enter a valid email address.");
                return;
              }
              setError("");
              setLoading(true);
              try {
                if (nextEmail !== me?.email) {
                  await updateAccountEmail(nextEmail, "onboarding");
                }
                goTo("verify");
              } catch (err) {
                setError(err.message || "Could not update your email. Check it and try again.");
              } finally {
                setLoading(false);
              }
            }}
          >
            <ShakeTarget shake={error}>
              <div>
                <label htmlFor="signed-in-email" className="block font-mono text-xl text-card-foreground mb-3 leading-snug">
                  Email address
                </label>
                <Input
                  id="signed-in-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                />
              </div>
            </ShakeTarget>
            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={loading}
              disabled={!emailOk(email)}
            >
              {email.trim() === me?.email
                ? "Continue to verification"
                : "Update email and send link"}
            </Button>
          </form>
        </StepShell>
      );
    }

    return (
      <StepShell icon={User} title="Continue with your account">
        <p className="text-muted-foreground text-sm leading-relaxed mb-6 text-pretty">
          {path === "diy"
            ? shouldSkipCodeEntry(me)
              ? "You are already signed in and this Luna is linked. Continue to name it or finish setup."
              : me?.human_verified
                ? "You are already signed in. Continue to get a setup code for this Luna. We will not charge another dollar."
                : "You are already signed in. Next we confirm you are a real person, then give you a setup code for this Luna."
            : shouldSkipCodeEntry(me)
              ? "You are already signed in and this Luna is linked. Continue to name it or finish setup."
              : "You are already signed in. Continue to link this Luna with its device code."}
        </p>
        <p className="font-mono text-sm text-card-foreground mb-8 break-all">{me?.email}</p>
        <Button
          size="lg"
          className="w-full"
          loading={loading}
          onClick={async () => {
            setError("");
            setLoading(true);
            try {
              await continueAfterVerification(me);
            } catch (err) {
              setError(err.message || "Could not continue. Try again.");
            } finally {
              setLoading(false);
            }
          }}
        >
          Continue <ArrowRight className="w-4 h-4" />
        </Button>
      </StepShell>
    );
  };

  const renderVerify = () => {
    const displayEmail = me?.email || email;
    return (
      <StepShell icon={MailOpen} title="Check your inbox">
        <p className="text-muted-foreground text-sm leading-relaxed mb-8 text-pretty">
          We sent a verification link to <span className="font-mono text-card-foreground">{displayEmail}</span>.
          Open the email from Luna Connect and choose <span className="font-mono text-card-foreground">Verify my email</span>.
          This page continues by itself when you are done.
        </p>
        <div className="space-y-5">
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Waiting for verification…
          </div>
          <Button
            size="lg"
            className="w-full"
            loading={checkingVerification}
            onClick={async () => {
              setCheckingVerification(true);
              setError("");
              try {
                const status = await api("/api/v1/account/verification-status");
                if (!status.email_verified) {
                  setError("We do not see the verification yet. Open the link in the email, then try again.");
                  return;
                }
                await advancePastVerify();
              } catch (err) {
                setError(err.message || "Could not check your verification. Try again in a moment.");
              } finally {
                setCheckingVerification(false);
              }
            }}
          >
            Check again
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {resendState === "sent" ? (
              "Verification email sent. Check your inbox and spam folder."
            ) : (
              <>
                Did not get it?{" "}
                <button
                  type="button"
                  disabled={cooldown > 0 || resendState === "sending"}
                  className="underline underline-offset-2 hover:text-card-foreground motion-safe:transition-colors disabled:opacity-60 disabled:pointer-events-none"
                  onClick={async () => {
                    setResendState("sending");
                    setError("");
                    try {
                      const res = await api("/api/v1/account/resend-verification", {
                        method: "POST",
                        body: JSON.stringify({ source: "onboarding" }),
                      });
                      if (res?.email_verified || res?.already_verified) {
                        await advancePastVerify();
                        return;
                      }
                      setResendState("sent");
                      setCooldown(60);
                    } catch (err) {
                      // Older backends returned 400 "already verified" — still advance.
                      if (/already verified/i.test(err.message || "")) {
                        try {
                          await advancePastVerify();
                          return;
                        } catch (advanceErr) {
                          setError(advanceErr.message || "Could not continue. Try again.");
                          setResendState("idle");
                          return;
                        }
                      }
                      setError(err.message || "Could not resend the email. Try again.");
                      setResendState("idle");
                    }
                  }}
                >
                  {resendState === "sending"
                    ? "Sending…"
                    : cooldown > 0
                      ? `Resend in ${cooldown}s`
                      : "Resend the email"}
                </button>
                .
              </>
            )}
          </p>
          <p className="text-center text-sm text-muted-foreground">
            Want to change your email?{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-card-foreground motion-safe:transition-colors"
              onClick={() => {
                setError("");
                if (!email && displayEmail) setEmail(displayEmail);
                goTo("account", "left");
              }}
            >
              Go Back
            </button>
          </p>
        </div>
      </StepShell>
    );
  };

  const renderCode = () => (
    <StepShell icon={Key} title="Enter the device code">
      <p className="text-muted-foreground text-sm leading-relaxed mb-8 text-pretty">
        The code on your quick-start card (****-****-****-****-****).
      </p>
      <form
        className="space-y-5 text-left"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setLoading(true);
          try {
            await bindDevice(code);
            goTo("domain");
          } catch (err) {
            setError(err.message);
          } finally {
            setLoading(false);
          }
        }}
      >
        <label htmlFor="code" className="block font-mono text-xl text-card-foreground mb-3 leading-snug">
          Device code
        </label>
        <ShakeTarget shake={error}>
          <Input
            id="code"
            className="font-mono uppercase tracking-widest"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="****-****-****-****-****"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-invalid={Boolean(error)}
          />
        </ShakeTarget>
        <Button type="submit" size="lg" className="w-full" loading={loading} disabled={code.trim().length < 6}>
          Continue <ArrowRight className="w-4 h-4" />
        </Button>
      </form>
    </StepShell>
  );

  const renderDiyCode = () => (
    <StepShell icon={Key} title="Your device code">
      <p className="font-mono text-xl sm:text-2xl tracking-widest break-all mb-6">{diyCode}</p>
      <p className="text-sm text-foreground mb-4 leading-relaxed text-pretty">
        During Luna OS install, after the disk is written, the installer asks for your device code on the screen connected to Luna. Paste this
        full code (****-****-****-****-****), or press Enter to skip. The first eight characters (****-****) let you finish setup from your
        phone on your home network.
      </p>
      <p className="text-sm text-muted-foreground mb-4 leading-relaxed text-pretty">
        If you skipped the code during install, on Luna go to Settings → About → Advanced, open Setup code, paste this code, and tap Save
        setup code.
      </p>
      <p className="text-sm text-muted-foreground mb-8 leading-relaxed text-pretty">
        When you continue, we link this code to your account. Luna picks up the link when it is online.
      </p>
      <div className="flex flex-col gap-3">
        <Button size="lg" className="w-full" variant="outline" onClick={() => handleCopy("diy", diyCode)}>
          {copied === "diy" ? (
            <>
              <Check className="w-4 h-4" /> Copied
            </>
          ) : (
            <>
              <Copy className="w-4 h-4" /> Copy code
            </>
          )}
        </Button>
        <Button
          size="lg"
          className="w-full"
          loading={loading}
          onClick={async () => {
            setError("");
            setLoading(true);
            try {
              await bindDevice(diyCode);
              goTo("domain");
            } catch (err) {
              setError(err.message);
            } finally {
              setLoading(false);
            }
          }}
        >
          Continue <ArrowRight className="w-4 h-4" />
        </Button>
      </div>
    </StepShell>
  );

  const renderDomain = () => (
    <StepShell icon={Globe} title="Name this Luna">
      <p className="text-muted-foreground text-sm leading-relaxed mb-8 text-pretty">
        This name is the address you type to open Luna when you are not at home. Use letters and numbers, at least 3 characters.
      </p>
      <form
        className="space-y-5 text-left"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setLoading(true);
          try {
            let id = deviceId;
            if (!id) {
              const devices = await api("/api/v1/account/devices");
              id = devices.devices?.[0]?.id || "";
              if (id) setDeviceId(id);
            }
            if (!id) {
              setError("We could not find a linked Luna yet. Go back and enter the device code again.");
              return;
            }
            const created = await api(`/api/v1/devices/${id}/domain`, {
              method: "POST",
              body: JSON.stringify({ subdomain: name }),
            });
            setHostname(created.hostname);
            setSetupSecret(created.setup_secret || "");
            goTo("backup");
          } catch (err) {
            setError(err.message);
          } finally {
            setLoading(false);
          }
        }}
      >
        <ShakeTarget shake={error}>
          <div>
            <label htmlFor="name" className="block font-mono text-xl text-card-foreground mb-3 leading-snug">
              Name
            </label>
            <Input
              id="name"
              className="font-mono"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="kitchen"
              autoFocus
            />
            <p className="text-sm font-mono text-foreground">
              {name.trim() ? `${name.trim().toLowerCase()}.${PUBLIC_ZONE}` : `kitchen.${PUBLIC_ZONE}`}
            </p>
          </div>
        </ShakeTarget>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Luna applies this address when it is online. You can finish here either way.
        </p>
        <Button type="submit" size="lg" className="w-full" loading={loading} disabled={name.trim().length < 3}>
          Use this name <ArrowRight className="w-4 h-4" />
        </Button>
      </form>
    </StepShell>
  );

  const renderBackup = () => (
    <StepShell icon={HardDrive} title="Optional cloud backup">
      <p className="text-sm text-foreground leading-relaxed mb-8 text-pretty">
        Cloud backup costs $8 per terabyte each month, based on your average storage over the month.
        Downloads are free up to three times that average; extra download traffic costs $0.01 per GB.
        The address stays free if you skip this.
      </p>
      {stripeLooksConfigured(me) ? (
        <VerifyHumanCard
          account={me}
          loading={loading}
          description="Add a payment card to turn on cloud backup. The monthly price is based on your average storage."
          buttonLabel="Turn on cloud backup"
          onConfirm={async (paymentMethodId) => {
            setError("");
            setLoading(true);
            try {
              await api("/api/v1/onboarding/backups", {
                method: "POST",
                body: JSON.stringify({
                  enable: true,
                  payment_method_id: paymentMethodId,
                  device_id: deviceId || undefined,
                }),
              });
              goTo("done");
            } catch (err) {
              setError(err.message);
            } finally {
              setLoading(false);
            }
          }}
        />
      ) : (
        <Button
          size="lg"
          className="w-full mb-3"
          loading={loading}
          onClick={async () => {
            setError("");
            setLoading(true);
            try {
              await api("/api/v1/onboarding/backups", {
                method: "POST",
                body: JSON.stringify({ enable: true, device_id: deviceId || undefined }),
              });
              goTo("done");
            } catch (err) {
              setError(err.message);
            } finally {
              setLoading(false);
            }
          }}
        >
          Turn on cloud backup
        </Button>
      )}
      <Button
        variant="outline"
        size="lg"
        className="w-full mt-3"
        onClick={async () => {
          setError("");
          try {
            await api("/api/v1/onboarding/backups", {
              method: "POST",
              body: JSON.stringify({ enable: false }),
            });
          } catch {
            /* still allow finishing */
          }
          goTo("done");
        }}
      >
        Skip for now
      </Button>
    </StepShell>
  );

  const renderDone = () => (
    <StepShell icon={Check} title="You can open Luna from away">
      <div className="space-y-6 text-left">
        <div>
          <p className="text-sm text-foreground mb-2">Open Luna at:</p>
          <div className="rounded-large-element bg-muted border border-border p-4 flex items-center gap-3">
            <p className="font-mono text-sm break-all flex-1 text-foreground">{hostname}</p>
            <Button variant="ghost" size="icon" onClick={() => handleCopy("host", hostname)} aria-label="Copy address">
              {copied === "host" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Luna applies these settings when it is online. Keep it plugged into your router or modem with the RJ45 (ethernet) cable.
        </p>
        <p className="text-sm text-foreground leading-relaxed">
          The first time you visit that address, create your Luna login there. That login is separate from this Luna Connect account. Paste this one-time code when you create it so only you — the person who just finished setup here — can make that first account.
        </p>
        {setupSecret && (
          <div className="rounded-large-element bg-muted border border-border p-4 flex items-center gap-3">
            <p className="font-mono text-sm break-all flex-1 text-foreground">{setupSecret}</p>
            <Button variant="ghost" size="icon" onClick={() => handleCopy("secret", setupSecret)} aria-label="Copy one-time setup code">
              {copied === "secret" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        )}
        <ol className="space-y-2.5 text-sm text-muted-foreground">
          <li className="flex gap-2.5">
            <span className="font-mono text-card-foreground">1.</span>
            Copy the one-time code
          </li>
          <li className="flex gap-2.5">
            <span className="font-mono text-card-foreground">2.</span>
            Open the address above
          </li>
          <li className="flex gap-2.5">
            <span className="font-mono text-card-foreground">3.</span>
            Create your Luna login and paste the code once. Do not put it in the address bar.
          </li>
        </ol>
        <Button
          size="lg"
          className="w-full"
          onClick={() => {
            clearProgress();
            navigate("/");
          }}
        >
          Done
        </Button>
      </div>
    </StepShell>
  );

  let body = null;
  if (step === "welcome" && path === "official") body = renderWelcome();
  else if (step === "account" && !isAuthenticated) body = renderAccount();
  else if (step === "account" && isAuthenticated) body = renderSignedInAccount();
  else if (step === "verify") body = renderVerify();
  else if (step === "card") {
    body = (
      <StepShell icon={User} title="Confirm this is a real person">
        <p className="text-sm text-foreground mb-6 leading-relaxed">
          A dollar to confirm this is a real person; it counts toward cloud backup if you turn it on.
        </p>
        <VerifyHumanCard
          account={me}
          loading={loading}
          onConfirm={async (paymentMethodId) => {
            setError("");
            setLoading(true);
            try {
              await finishDiyVerify(paymentMethodId);
            } catch (err) {
              setError(err.message);
            } finally {
              setLoading(false);
            }
          }}
        />
      </StepShell>
    );
  } else if (step === "diy-code") body = renderDiyCode();
  else if (step === "code") body = renderCode();
  else if (step === "domain") body = renderDomain();
  else if (step === "backup") body = renderBackup();
  else if (step === "done") body = renderDone();
  else if (path === "diy") body = isAuthenticated ? renderSignedInAccount() : renderAccount();
  else body = renderWelcome();

  const showBack = !(
    (path === "official" && step === "welcome") ||
    step === "done" ||
    (path === "diy" && step === "account" && authSubStep === 0 && !isAuthenticated)
  );

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <button
        type="button"
        onClick={toggle}
        className="absolute top-4 right-4 rounded-pill p-2 text-muted-foreground hover:bg-accent transition-colors"
        aria-label="Toggle dark mode"
      >
        <Sun className="h-5 w-5 dark:hidden" />
        <Moon className="h-5 w-5 hidden dark:block" />
      </button>
      <ProgressBar stepId={step} path={path} />
      <div className="flex-1 flex items-start sm:items-center justify-center px-4 pb-8">
        <div
          ref={outerRef}
          className="w-full max-w-xl rounded-large-element border border-border bg-card text-card-foreground shadow-[0_32px_80px_rgba(0,0,0,0.12)] overflow-hidden transition-[height] ease-[cubic-bezier(0.05,0.7,0.1,1)]"
          style={{ transitionDuration: "300ms" }}
        >
          <div ref={innerRef} className="px-6 sm:px-12 py-12">
            <ErrorBanner error={error} onDismiss={() => setError("")} />
            <div
              key={step}
              className={cn(direction === "left" ? "slide-in-from-left-pop" : "slide-in-from-right-pop")}
              style={{ animationDuration: "300ms", animationFillMode: "both" }}
            >
              {body}
            </div>
          </div>
        </div>
      </div>
      {showBack && (
        <div className="px-4 pb-8 flex justify-center">
          <Button variant="outline" onClick={handleBack}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        </div>
      )}
    </div>
  );
}
