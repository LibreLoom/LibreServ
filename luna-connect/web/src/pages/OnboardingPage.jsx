import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Cable,
  CreditCard,
  Check,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Hammer,
  KeyRound,
  Loader2,
  MailOpen,
  Package,
  Sparkles,
  User,
  X,
} from "lucide-react";
import { api } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";
import { Button } from "../components/ui/button.jsx";
import { VerifyHumanCard } from "../components/VerifyHumanCard.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useAnimatedHeight } from "../hooks/useAnimatedHeight.js";
import { cn } from "../lib/utils.js";

/** @typedef {"path"|"code"|"account"|"verify"|"card"|"oss-code"|"plug"|"name"|"copies"|"done"} OnboardingStep */
/** @typedef {"official"|"oss"} OnboardingPath */

const PROGRESS_KEY = "luna-connect-onboarding-progress";
const VALID_STEPS = new Set([
  "path", "code", "account", "verify", "card", "oss-code", "plug", "name", "copies", "done",
]);
const VALID_PATHS = new Set(["official", "oss"]);

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** @param {Record<string, unknown>} data */
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

/**
 * @param {unknown} saved
 * @param {boolean} humanVerified
 */
function seedFromProgress(saved, humanVerified) {
  const s = saved && typeof saved === "object" ? /** @type {Record<string, unknown>} */ (saved) : {};
  let step = typeof s.step === "string" && VALID_STEPS.has(s.step) ? /** @type {OnboardingStep} */ (s.step) : "path";
  let path = typeof s.path === "string" && VALID_PATHS.has(s.path) ? /** @type {OnboardingPath} */ (s.path) : "official";
  if (step === "card" && humanVerified) step = "account";
  if (step === "oss-code" && !(typeof s.ossCode === "string" && s.ossCode)) step = "account";
  return {
    step,
    path,
    code: typeof s.code === "string" ? s.code : "",
    email: typeof s.email === "string" ? s.email : "",
    name: typeof s.name === "string" ? s.name : "",
    ossCode: typeof s.ossCode === "string" ? s.ossCode : "",
    hostname: typeof s.hostname === "string" ? s.hostname : "",
    setupSecret: typeof s.setupSecret === "string" ? s.setupSecret : "",
  };
}

/**
 * @param {OnboardingPath} path
 * @param {boolean} includeCard
 */
function stepsForPath(path, includeCard) {
  if (path === "oss") {
    return [
      { id: "path", label: "Start" },
      { id: "account", label: "Account" },
      { id: "verify", label: "Email" },
      ...(includeCard ? [{ id: "card", label: "Verify" }] : []),
      { id: "oss-code", label: "Code" },
      { id: "plug", label: "Plug in" },
      { id: "name", label: "Name" },
      { id: "copies", label: "Backup" },
      { id: "done", label: "Done" },
    ];
  }
  return [
    { id: "path", label: "Start" },
    { id: "code", label: "Code" },
    { id: "account", label: "Account" },
    { id: "verify", label: "Email" },
    { id: "plug", label: "Plug in" },
    { id: "name", label: "Name" },
    { id: "copies", label: "Backup" },
    { id: "done", label: "Done" },
  ];
}

/** @param {{ steps: Array<{id: string, label: string}>, stepIndex: number }} props */
function ProgressBar({ steps, stepIndex }) {
  return (
    <div className="flex items-center justify-center pt-10 pb-8 px-4" role="list" aria-label="Setup progress">
      {steps.map((s, i) => (
        <div key={s.id} className="flex items-center" role="listitem">
          <div className="flex flex-col items-center gap-2">
            <div
              className={cn(
                "relative flex items-center justify-center w-9 h-9 rounded-full text-xs font-mono motion-safe:transition-all motion-safe:duration-300",
                i < stepIndex
                  ? "bg-foreground text-background"
                  : i === stepIndex
                    ? "bg-foreground text-background scale-110 shadow-[0_0_0_5px_var(--ring-soft)]"
                    : "bg-muted text-muted-foreground",
              )}
              aria-current={i === stepIndex ? "step" : undefined}
            >
              {i < stepIndex ? (
                <Check className="w-4 h-4 animate-check-pop" />
              ) : (
                <span className={cn(i === stepIndex && "animate-fade-in")}>{i + 1}</span>
              )}
            </div>
            <span
              className={cn(
                "hidden sm:block text-[11px] font-mono motion-safe:transition-colors motion-safe:duration-300",
                i === stepIndex ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className="relative w-6 sm:w-12 h-0.5 mx-2 mb-0 sm:mb-6 bg-muted overflow-hidden rounded-full">
              <div
                className="absolute inset-y-0 left-0 bg-foreground motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.05,0.7,0.1,1)]"
                style={{ width: i < stepIndex ? "100%" : "0%" }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** @param {{ error: string, onDismiss: () => void }} props */
function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div className="rounded-large-element bg-error/10 border-2 border-error/30 p-4 flex items-start gap-3 mb-8 animate-fade-in-up">
      <X className="w-4 h-4 text-error mt-0.5 shrink-0" />
      <p className="text-sm text-error flex-1 leading-relaxed text-left">{error}</p>
      <button type="button" onClick={onDismiss} className="text-error hover:opacity-80 motion-safe:transition-opacity" aria-label="Dismiss error">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/** @param {{ icon: import("lucide-react").LucideIcon, title: string, children: import("react").ReactNode, wide?: boolean }} props */
function StepShell({ icon: Icon, title, children, wide = false }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center mb-6 animate-step-icon">
        <Icon size={26} className="text-foreground" strokeWidth={1.75} />
      </div>
      <h1 className="font-mono text-[1.75rem] leading-snug font-normal text-card-foreground tracking-tight mb-3 text-balance">
        {title}
      </h1>
      <div className={cn("w-full", wide ? "max-w-md" : "max-w-sm")}>
        {children}
      </div>
    </div>
  );
}

export default function OnboardingPage() {
  const { isAuthenticated, register, me, refresh, markEmailVerified, updateAccountEmail } = useAuth();
  const navigate = useNavigate();
  const saved = useRef(loadProgress());
  const seed = seedFromProgress(saved.current, Boolean(me?.human_verified));
  /** @type {[OnboardingStep, function(OnboardingStep): void]} */
  const [step, setStep] = useState(seed.step);
  /** @type {[OnboardingPath, function(OnboardingPath): void]} */
  const [path, setPath] = useState(seed.path);
  const [direction, setDirection] = useState("right");
  const [code, setCode] = useState(seed.code);
  const [email, setEmail] = useState(seed.email);
  const [password, setPassword] = useState("");
  const [name, setName] = useState(seed.name);
  const [ossCode, setOssCode] = useState(seed.ossCode);
  const [hostname, setHostname] = useState(seed.hostname);
  const [setupSecret, setSetupSecret] = useState(seed.setupSecret);
  const [error, setError] = useState("");
  const [waitMsg, setWaitMsg] = useState("");
  const [lunaOnline, setLunaOnline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkingVerification, setCheckingVerification] = useState(false);
  const [resendState, setResendState] = useState("idle");
  const [cooldown, setCooldown] = useState(0);
  const { outerRef, innerRef } = useAnimatedHeight();

  const includeCard = path === "oss" && stripeLooksConfigured(me) && !me?.human_verified;
  const steps = stepsForPath(path, includeCard || step === "card");
  const stepIndex = Math.max(0, steps.findIndex((s) => s.id === step));
  const emailVerified = Boolean(me?.email_verified);

  /** @param {OnboardingStep} next */
  function goTo(next, dir = "right") {
    setDirection(dir);
    setStep(next);
    setError("");
  }

  async function bindCode(value) {
    const s = await api("/api/v1/onboarding/bind", { method: "POST", body: JSON.stringify({ code: value }) });
    setWaitMsg(s.message || "");
    if (s.status === "attached" || s.live === true) setLunaOnline(true);
    return s;
  }

  async function mintOssCode() {
    const minted = await api("/api/v1/account/oss-token", { method: "POST", body: "{}" });
    setOssCode(minted.code);
    setWaitMsg(minted.message);
    goTo("oss-code");
  }

  async function finishOssVerify(paymentMethodId) {
    const body = paymentMethodId
      ? JSON.stringify({ payment_method_id: paymentMethodId })
      : "{}";
    await api("/api/v1/account/verify-human", { method: "POST", body });
    await refresh();
    await mintOssCode();
  }

  async function afterOssAccount(account) {
    const acct = account || me;
    if (acct?.human_verified) {
      await mintOssCode();
      return;
    }
    if (stripeLooksConfigured(acct)) {
      goTo("card");
      return;
    }
    await finishOssVerify();
  }

  async function afterEmailVerified(account) {
    const acct = account || me;
    if (path === "oss") {
      await afterOssAccount(acct);
      return;
    }
    if (code) await bindCode(code);
    await api("/api/v1/onboarding/attach-account", { method: "POST", body: "{}" });
    goTo("plug");
  }

  useEffect(() => {
    if (step === "path" && !code && !email && !name && !ossCode) return;
    saveProgress({ step, path, code, email, name, ossCode, hostname, setupSecret });
  }, [step, path, code, email, name, ossCode, hostname, setupSecret]);

  useEffect(() => {
    if (me?.human_verified && step === "card") setStep("account");
  }, [me?.human_verified, step]);

  useEffect(() => {
    if (!emailVerified || step !== "verify") return undefined;
    let cancelled = false;
    (async () => {
      try {
        if (!cancelled) await afterEmailVerified(me);
      } catch (err) {
        if (!cancelled) setError(err.message || "Could not continue. Try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailVerified, step]);

  useEffect(() => {
    if (step !== "verify" || emailVerified) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api("/api/v1/account/verification-status");
        if (!cancelled && res.email_verified) {
          markEmailVerified?.();
          await refresh();
        }
      } catch {
        /* keep waiting */
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [step, emailVerified, markEmailVerified, refresh]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (step !== "code" && step !== "plug") return undefined;
    const poll = async () => {
      try {
        const s = await api("/api/v1/onboarding/session");
        setWaitMsg(s.message || "");
        const online = s.status === "attached" || s.live === true;
        if (online) setLunaOnline(true);
        if (s.status === "attached" && step === "code" && isAuthenticated && emailVerified) {
          setDirection("right");
          setStep("plug");
        }
      } catch {
        /* waiting room is optional until bind */
      }
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, [step, isAuthenticated, emailVerified]);

  function handleBack() {
    if (step === "path") {
      navigate("/");
      return;
    }
    if (step === "code") {
      goTo("path", "left");
      return;
    }
    if (step === "account") {
      goTo(path === "oss" ? "path" : "code", "left");
      return;
    }
    if (step === "verify") {
      goTo("account", "left");
      return;
    }
    if (step === "card") {
      goTo("verify", "left");
      return;
    }
    if (step === "oss-code") {
      goTo(includeCard || (stripeLooksConfigured(me) && !me?.human_verified) ? "card" : "verify", "left");
      return;
    }
    if (step === "plug") {
      if (path === "oss") goTo("oss-code", "left");
      else goTo(isAuthenticated ? (emailVerified ? "code" : "verify") : "account", "left");
      return;
    }
    if (step === "name") {
      goTo("plug", "left");
      return;
    }
    if (step === "copies") {
      goTo("name", "left");
    }
  }

  /** @returns {import("react").ReactNode} */
  function renderStep() {
    if (step === "path") {
      return (
        <StepShell icon={Sparkles} title="Set up Luna" wide>
          <p className="text-muted-foreground text-sm leading-relaxed mb-8 text-pretty">
            Where did this Luna originate?
          </p>
          <div className="w-full max-w-md mx-auto space-y-3 mb-8">
            <button
              type="button"
              className="w-full rounded-large-element border-2 border-border bg-card text-card-foreground p-4 text-left motion-safe:transition-all motion-safe:duration-200 hover:border-foreground/40 hover:bg-accent cursor-pointer"
              onClick={() => {
                setPath("official");
                goTo("code");
              }}
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <Package size={18} className="text-foreground" strokeWidth={1.75} />
                </div>
                <div>
                  <span className="font-mono text-sm text-card-foreground block">Purchased from LibreLoom</span>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    You bought this Luna and have a device code that came with it (also shown on the screen).
                  </p>
                </div>
              </div>
            </button>
            <button
              type="button"
              className="w-full rounded-large-element border-2 border-border bg-card text-card-foreground p-4 text-left motion-safe:transition-all motion-safe:duration-200 hover:border-foreground/40 hover:bg-accent cursor-pointer"
              onClick={() => {
                setPath("oss");
                goTo("account");
              }}
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <Hammer size={18} className="text-foreground" strokeWidth={1.75} />
                </div>
                <div>
                  <span className="font-mono text-sm text-card-foreground block">I built it myself</span>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    You installed Luna on your own computer. We will give you a setup code on the next screens.
                  </p>
                </div>
              </div>
            </button>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed text-pretty max-w-md mx-auto">
            You will plug Luna into power and into your router in a later step.
          </p>
        </StepShell>
      );
    }

    if (step === "code") {
      return (
        <StepShell icon={KeyRound} title="Enter your device code">
          <p className="text-muted-foreground text-sm leading-relaxed mb-8 text-pretty">
            Type the device code that came with your Luna (groups of letters and numbers). The same code is on the screen if you need it.
          </p>
          <form
            className="space-y-4 text-left"
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              setLoading(true);
              try {
                await bindCode(code);
                if (isAuthenticated && emailVerified) goTo("plug");
                else if (isAuthenticated && !emailVerified) goTo("verify");
                else goTo("account");
              } catch (err) {
                setError(err.message);
              } finally {
                setLoading(false);
              }
            }}
          >
            <div>
              <Label htmlFor="code">Device code</Label>
              <Input
                id="code"
                className="font-mono uppercase tracking-widest h-12"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="****-****-****-****-****"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </div>
            {waitMsg && <p className="text-sm text-foreground">{waitMsg}</p>}
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              Continue <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </form>
        </StepShell>
      );
    }

    if (step === "account" && isAuthenticated && emailVerified) {
      return (
        <StepShell icon={User} title="Continue with your account">
          <p className="text-muted-foreground text-sm leading-relaxed mb-6 text-pretty">
            {path === "oss"
              ? me?.human_verified
                ? "You are already signed in. Continue to get a new setup code for this Luna — we will not charge another dollar."
                : "You are already signed in. Next we confirm you are a real person with a one-dollar card check, then give you a setup code for this Luna."
              : "You are already signed in. Next you will plug Luna in, then name it."}
          </p>
          <p className="font-mono text-sm text-card-foreground mb-8 break-all">{me?.email}</p>
          <Button
            className="w-full"
            size="lg"
            loading={loading}
            onClick={async () => {
              setError("");
              setLoading(true);
              try {
                await afterEmailVerified(me);
              } catch (err) {
                setError(err.message);
              } finally {
                setLoading(false);
              }
            }}
          >
            Continue <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </StepShell>
      );
    }

    if (step === "account") {
      return (
        <StepShell icon={User} title={isAuthenticated && !emailVerified ? "Fix your email" : "Create your Luna Connect account"}>
          <p className="text-muted-foreground text-sm leading-relaxed mb-8 text-pretty">
            {isAuthenticated && !emailVerified
              ? "Update the address if there was a typo. We will send a new verification link."
              : "This account is for Luna Connect — opening Luna when you are away, and optional cloud backup."}
          </p>
          <form
            className="space-y-4 text-left"
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              setLoading(true);
              try {
                if (isAuthenticated && !emailVerified) {
                  await updateAccountEmail(email, "onboarding");
                  goTo("verify");
                  return;
                }
                await register(email, password);
                goTo("verify");
              } catch (err) {
                setError(err.message);
              } finally {
                setLoading(false);
              }
            }}
          >
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </div>
            {!(isAuthenticated && !emailVerified) && (
              <div>
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 12 characters, with a letter and a number"
                />
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                  At least 12 characters, including a letter and a number. That is so a stolen password list is less likely to open this account.
                </p>
              </div>
            )}
            <Button type="submit" className="w-full" size="lg" loading={loading}>
              {isAuthenticated && !emailVerified ? "Update email" : "Create account"}
            </Button>
            {!(isAuthenticated && !emailVerified) && (
              <p className="text-sm text-muted-foreground text-center">
                Already have an account?{" "}
                <Link className="underline underline-offset-4 hover:text-card-foreground" to="/login">
                  Sign in
                </Link>
              </p>
            )}
          </form>
        </StepShell>
      );
    }

    if (step === "verify") {
      const displayEmail = email || me?.email || "";
      return (
        <StepShell icon={MailOpen} title="Check your inbox">
          <p className="text-muted-foreground text-sm leading-relaxed max-w-md mx-auto mb-8">
            We sent a verification link to{" "}
            <span className="font-mono text-card-foreground">{displayEmail}</span>. Open the email from Luna Connect and click{" "}
            <span className="font-mono text-card-foreground">Verify my email</span> — this page unlocks by itself when you are done.
          </p>
          <div className="w-full max-w-sm mx-auto space-y-6 animate-fade-in-up">
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Waiting for verification…
            </div>
            <div className="flex items-center gap-3">
              <Button type="button" variant="outline" size="lg" onClick={handleBack} aria-label="Go back" className="shrink-0">
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                size="lg"
                className="flex-1"
                loading={checkingVerification}
                onClick={async () => {
                  setCheckingVerification(true);
                  setError("");
                  try {
                    const res = await api("/api/v1/account/verification-status");
                    if (res.email_verified) {
                      markEmailVerified?.();
                      await refresh();
                    } else {
                      setError(
                        "We do not see the verification yet. Click the link in the email first, then try again — or resend it below.",
                      );
                    }
                  } catch {
                    setError("Could not check your verification status. Try again in a moment.");
                  } finally {
                    setCheckingVerification(false);
                  }
                }}
              >
                Check Again
              </Button>
            </div>
            <p className="text-center text-sm text-muted-foreground">
              {resendState === "sent" ? (
                "Verification email sent — check your inbox (and spam folder)."
              ) : (
                <>
                  Did not get it? Check your spam folder, or{" "}
                  <button
                    type="button"
                    disabled={cooldown > 0 || resendState === "sending"}
                    className="underline underline-offset-2 hover:text-card-foreground motion-safe:transition-colors disabled:opacity-60 disabled:pointer-events-none"
                    onClick={async () => {
                      setResendState("sending");
                      setError("");
                      try {
                        await api("/api/v1/account/resend-verification", {
                          method: "POST",
                          body: JSON.stringify({ source: "onboarding" }),
                        });
                        setResendState("sent");
                        setCooldown(60);
                      } catch (err) {
                        setError(err.message || "Could not resend the email. Try again.");
                        setResendState("idle");
                      }
                    }}
                  >
                    {resendState === "sending"
                      ? "Sending…"
                      : cooldown > 0
                        ? `Resend in ${cooldown}s`
                        : "Resend Verification Email"}
                  </button>
                  .
                </>
              )}
            </p>
          </div>
        </StepShell>
      );
    }

    if (step === "card") {
      return (
        <StepShell icon={CreditCard} title="Confirm you are a real person">
          <p className="text-muted-foreground text-sm leading-relaxed mb-8 text-pretty">
            A dollar confirms this is a real person. It counts toward cloud backup if you turn that on later.
          </p>
          <VerifyHumanCard
            account={me}
            loading={loading}
            description=""
            onConfirm={async (paymentMethodId) => {
              setError("");
              setLoading(true);
              try {
                await finishOssVerify(paymentMethodId);
              } catch (err) {
                setError(err.message);
              } finally {
                setLoading(false);
              }
            }}
          />
        </StepShell>
      );
    }

    if (step === "oss-code") {
      return (
        <StepShell icon={KeyRound} title="Your setup code">
          <p className="text-muted-foreground text-sm leading-relaxed mb-6 text-pretty">
            You can enter this code during the installer process, or you can edit the setup code on your device through About → Advanced.
          </p>
          <p className="font-mono text-xl sm:text-2xl tracking-widest text-center break-all mb-8 animate-fade-in-up">
            {ossCode}
          </p>
          <Button
            className="w-full"
            size="lg"
            onClick={async () => {
              try {
                await bindCode(ossCode);
                goTo("plug");
              } catch (err) {
                setError(err.message);
              }
            }}
          >
            I entered it on Luna <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </StepShell>
      );
    }

    if (step === "plug") {
      return (
        <StepShell icon={Cable} title="Plug Luna in">
          <div className="space-y-4 text-left mb-8">
            <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
              Stay on your home internet for this step. Do this before you name Luna:
            </p>
            <ol className="list-decimal list-inside space-y-3 text-sm text-card-foreground leading-relaxed">
              <li>Plug Luna into power with the included power cord.</li>
              <li>
                Plug Luna into your router or modem with the included RJ45 (ethernet) cable.
              </li>
              <li>Wait until Luna’s screen shows it is online, or until this page says Luna is connected.</li>
            </ol>
            <p
              className={cn(
                "rounded-large-element border px-4 py-3 text-sm leading-relaxed",
                lunaOnline
                  ? "border-success/30 bg-success/20 text-card-foreground"
                  : "border-border bg-muted text-muted-foreground",
              )}
            >
              {lunaOnline
                ? "Luna is connected. You can continue."
                : waitMsg || "Waiting for Luna to come online… Keep this page open."}
            </p>
          </div>
          <Button
            className="w-full"
            size="lg"
            loading={loading}
            disabled={!lunaOnline}
            onClick={async () => {
              setError("");
              setLoading(true);
              try {
                const s = await api("/api/v1/onboarding/session");
                if (s.status !== "attached" && s.live !== true) {
                  setLunaOnline(false);
                  setWaitMsg(s.message || "Luna is not online yet. Check power and the ethernet cable, then wait.");
                  setError("Luna is not online yet. Check power and the ethernet cable, then wait.");
                  return;
                }
                setLunaOnline(true);
                goTo("name");
              } catch (err) {
                setError(err.message);
              } finally {
                setLoading(false);
              }
            }}
          >
            {lunaOnline ? "Luna is plugged in" : "Not plugged in yet"} <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </StepShell>
      );
    }

    if (step === "name") {
      return (
        <StepShell icon={Package} title="Name this Luna">
          <p className="text-muted-foreground text-sm leading-relaxed mb-8 text-pretty">
            This name is the address you type to open Luna when you are not at home.
          </p>
          <form
            className="space-y-4 text-left"
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              setLoading(true);
              try {
                await api("/api/v1/onboarding/attach-account", { method: "POST", body: "{}" });
                const created = await api("/api/v1/onboarding/name", {
                  method: "POST",
                  body: JSON.stringify({ subdomain: name }),
                });
                setHostname(created.hostname);
                setSetupSecret(created.setup_secret || "");
                goTo("copies");
              } catch (err) {
                setError(err.message);
              } finally {
                setLoading(false);
              }
            }}
          >
            <div>
              <Label htmlFor="name">Name for this Luna</Label>
              <Input
                id="name"
                className="font-mono"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="kitchen"
                autoFocus
              />
              <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                People will open Luna at this address on phones and computers away from home. Use letters and numbers, at least 3 characters.
              </p>
              <p className="mt-3 rounded-large-element bg-muted px-4 py-2.5 font-mono text-sm text-foreground">
                {name ? `${name.toLowerCase()}.luna.servers.libreloom.org` : "kitchen.luna.servers.libreloom.org"}
              </p>
            </div>
            {waitMsg && <p className="text-sm">{waitMsg}</p>}
            <Button type="submit" className="w-full" size="lg" loading={loading} disabled={name.trim().length < 3}>
              Use this name <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </form>
        </StepShell>
      );
    }

    if (step === "copies") {
      return (
        <StepShell icon={Cloud} title="Optional cloud backup">
          <p className="text-muted-foreground text-sm leading-relaxed mb-8 text-pretty">
            Cloud backup costs $8 per terabyte each month, based on how much is stored. Not a flat $8 a month.
          </p>
          <div className="space-y-3">
            {stripeLooksConfigured(me) ? (
              <VerifyHumanCard
                account={me}
                loading={loading}
                description="Add a payment card to turn on cloud backup. It costs $8 per terabyte each month."
                buttonLabel="Turn on cloud backup"
                onConfirm={async (paymentMethodId) => {
                  setError("");
                  setLoading(true);
                  try {
                    await api("/api/v1/onboarding/backups", {
                      method: "POST",
                      body: JSON.stringify({ enable: true, payment_method_id: paymentMethodId }),
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
                className="w-full"
                size="lg"
                onClick={async () => {
                  try {
                    await api("/api/v1/onboarding/backups", { method: "POST", body: JSON.stringify({ enable: true }) });
                    goTo("done");
                  } catch (err) {
                    setError(err.message);
                  }
                }}
              >
                Turn on cloud backup
              </Button>
            )}
            <Button variant="outline" className="w-full" size="lg" onClick={() => goTo("done")}>
              Skip for now
            </Button>
          </div>
        </StepShell>
      );
    }

    if (step === "done") {
      return (
        <StepShell icon={Check} title="You can open Luna from away">
          <div className="space-y-4 text-left">
            <p className="text-sm text-muted-foreground">Open Luna at:</p>
            <p className="font-mono text-lg break-all text-card-foreground">{hostname}</p>
            <p className="text-sm text-foreground leading-relaxed">
              The first time you visit that address, create your Luna login there. That login is separate from this Luna Connect account. Paste this one-time code when you create it so only you — the person who just finished setup here — can make that first account. People who only know the address cannot.
            </p>
            {setupSecret && (
              <p className="font-mono text-lg break-all rounded-large-element border border-border bg-muted px-4 py-3 text-foreground animate-fade-in-up">
                {setupSecret}
              </p>
            )}
            <p className="text-sm text-muted-foreground">Write the code down. You type it once. Do not put it in the address bar.</p>
            <Button
              className="w-full"
              size="lg"
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
    }

    return null;
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <ProgressBar steps={steps} stepIndex={stepIndex} />

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
              {renderStep()}
            </div>
            {me && step !== "done" && (
              <p className="mt-8 text-xs text-muted-foreground text-center">Signed in as {me.email}</p>
            )}
          </div>
        </div>
      </div>

      {step !== "done" && step !== "verify" && (
        <div className="px-4 pb-8 flex justify-center">
          <Button variant="outline" onClick={handleBack}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        </div>
      )}
    </div>
  );
}
