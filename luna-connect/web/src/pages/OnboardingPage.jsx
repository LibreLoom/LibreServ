import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Cable,
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
import { VerifyHumanCard } from "../components/VerifyHumanCard.jsx";
import { Input } from "../components/ui/input.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useTheme } from "../context/ThemeContext.jsx";
import { useAnimatedHeight } from "../hooks/useAnimatedHeight.js";
import { cn } from "../lib/utils.js";

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "code", label: "Code" },
  { id: "account", label: "Account" },
  { id: "wait", label: "Connect" },
  { id: "name", label: "Name" },
  { id: "copies", label: "Backup" },
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

function passwordOk(pw) {
  return pw.length >= 12 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}

function emailOk(email) {
  return /^\S+@\S+\.\S+$/.test(email.trim());
}

function progressIndex(step, path) {
  if (step === "welcome") return 0;
  if (step === "code") return 1;
  if (step === "account" || step === "verify" || step === "card") return 2;
  if (step === "wait" || step === "oss-code") return 3;
  if (step === "name") return 4;
  if (step === "copies") return 5;
  if (step === "done") return 6;
  return path === "oss" ? 2 : 0;
}

function ProgressBar({ stepId, path }) {
  const step = progressIndex(stepId, path);
  return (
    <div className="flex items-center justify-center pt-10 pb-8 px-4" role="list" aria-label="Setup progress">
      {STEPS.map((s, i) => (
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
          {i < STEPS.length - 1 && (
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

export default function OnboardingPage() {
  const {
    isAuthenticated,
    register,
    login,
    me,
    refresh,
    markEmailVerified,
    updateAccountEmail,
  } = useAuth();
  const { toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const byoEntry = location.pathname === "/register";
  const saved = useRef(loadProgress());
  const resumeByo = Boolean(byoEntry && saved.current?.path === "oss");
  const [step, setStep] = useState(
    byoEntry && !resumeByo ? "account" : saved.current?.step || (byoEntry ? "account" : "welcome"),
  );
  const [path, setPath] = useState(byoEntry && !resumeByo ? "oss" : saved.current?.path || (byoEntry ? "oss" : "official"));
  const [direction, setDirection] = useState("right");
  const [error, setError] = useState("");
  const { outerRef, innerRef } = useAnimatedHeight();

  const [code, setCode] = useState(saved.current?.code || "");
  const [email, setEmail] = useState(saved.current?.email || "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState(saved.current?.name || "");
  const [ossCode, setOssCode] = useState(saved.current?.ossCode || "");
  const [hostname, setHostname] = useState(saved.current?.hostname || "");
  const [setupSecret, setSetupSecret] = useState(saved.current?.setupSecret || "");
  const [waitMsg, setWaitMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [isLoginMode, setIsLoginMode] = useState(false);
  const [authSubStep, setAuthSubStep] = useState(0);
  const [authSubDir, setAuthSubDir] = useState("right");
  const [copied, setCopied] = useState("");
  const [checkingVerification, setCheckingVerification] = useState(false);
  const [resendState, setResendState] = useState("idle");
  const [cooldown, setCooldown] = useState(0);

  const emailVerified = Boolean(me?.email_verified);

  const goTo = useCallback((next, dir = "right") => {
    setDirection(dir);
    setStep(next);
  }, []);

  useEffect(() => {
    if (step === "welcome" && !email && !code) return;
    saveProgress({
      step,
      path,
      code,
      email,
      name,
      ossCode,
      hostname,
      setupSecret,
    });
  }, [step, path, code, email, name, ossCode, hostname, setupSecret]);

  useEffect(() => {
    if (step !== "wait" && step !== "code" && step !== "name") return undefined;
    const t = setInterval(async () => {
      try {
        const s = await api("/api/v1/onboarding/session");
        setWaitMsg(s.message || "");
        const live = Boolean(s.live);
        if (live && s.status === "attached" && step === "wait") goTo("name");
        if (live && s.status === "attached" && step === "code" && isAuthenticated && emailVerified) {
          goTo("wait");
        }
        if (!live && step === "name") {
          goTo("wait");
        }
      } catch {
        /* waiting room is optional until bind */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [step, isAuthenticated, emailVerified, goTo]);

  useEffect(() => {
    if (step !== "verify" || emailVerified) return undefined;
    let cancelled = false;
    const check = async () => {
      try {
        const status = await api("/api/v1/account/verification-status");
        if (!cancelled && status.email_verified) {
          markEmailVerified?.();
          const account = await refresh();
          if (!cancelled) await continueAfterVerification(account);
        }
      } catch {
        /* keep waiting */
      }
    };
    check();
    const timer = setInterval(check, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // continueAfterVerification intentionally uses the current path and code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, emailVerified, markEmailVerified, refresh]);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function bindCode(value) {
    const s = await api("/api/v1/onboarding/bind", { method: "POST", body: JSON.stringify({ code: value }) });
    setWaitMsg(s.message || "");
    return s;
  }

  async function finishOssVerify(paymentMethodId) {
    const body = paymentMethodId
      ? JSON.stringify({ payment_method_id: paymentMethodId })
      : "{}";
    await api("/api/v1/account/verify-human", { method: "POST", body });
    await refresh();
    await mintOssCode();
  }

  async function mintOssCode() {
    const minted = await api("/api/v1/account/oss-token", { method: "POST", body: "{}" });
    setOssCode(minted.code);
    setWaitMsg(minted.message);
    goTo("oss-code");
  }

  async function afterOssAccount(account) {
    const current = account || me;
    if (current?.human_verified) {
      await mintOssCode();
      return;
    }
    if (stripeLooksConfigured(current)) {
      goTo("card");
      return;
    }
    await finishOssVerify();
  }

  async function afterOfficialAccount() {
    const session = code ? await bindCode(code) : null;
    await api("/api/v1/onboarding/attach-account", { method: "POST", body: "{}" });
    goTo(session?.status === "attached" && session?.live ? "name" : "wait");
  }

  async function continueAfterVerification(account) {
    if (path === "oss") {
      await afterOssAccount(account);
      return;
    }
    await afterOfficialAccount();
  }

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
          hint: "At least 12 characters, including a letter and a number. That is so a stolen password list is less likely to open this account.",
          value: password,
          setValue: setPassword,
          type: "password",
          placeholder: "At least 12 characters, with a letter and a number",
          autoComplete: "new-password",
          valid: passwordOk(password),
        },
      ];

  const currentAuthField = authFields[authSubStep] || authFields[0];
  const isLastAuthSubStep = authSubStep === authFields.length - 1;

  const handleAuth = async (e) => {
    e.preventDefault();
    if (!currentAuthField.valid || loading) return;
    if (!isLastAuthSubStep) {
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
    if (step === "welcome") {
      if (isAuthenticated) navigate("/");
      return;
    }
    if (step === "account" && authSubStep > 0) {
      setAuthSubDir("left");
      setAuthSubStep((s) => s - 1);
      return;
    }
    const back = {
      code: "welcome",
      account: path === "oss" ? "welcome" : "code",
      verify: "account",
      card: "account",
      "oss-code": "account",
      wait: path === "oss" ? "oss-code" : "account",
      name: "wait",
      copies: "name",
      done: "copies",
    };
    goTo(back[step] || "welcome", "left");
  };

  const renderWelcome = () => (
    <StepShell icon={Sparkles} title="Set up Luna Connect">
      <div className="space-y-4 mb-10 text-left">
        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
          The booklet sent you here so we can give this Luna a name on the internet. That address is free.
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
          Stay on your home internet. Plug Luna into power and into your router or modem with the included RJ45 (ethernet) cable.
        </p>
      </div>
      <div className="space-y-3">
        <Button
          size="lg"
          className="w-full"
          onClick={() => {
            setPath("official");
            goTo("code");
          }}
        >
          I have a booklet <ArrowRight className="w-5 h-5" />
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="w-full"
          onClick={() => {
            setPath("oss");
            setAuthSubStep(0);
            goTo("account");
          }}
        >
          I set this computer up myself
        </Button>
      </div>
    </StepShell>
  );

  const renderCode = () => (
    <StepShell icon={BookOpen} title="Type the booklet code">
      <p className="text-muted-foreground text-sm leading-relaxed mb-8 text-pretty">
        Groups of letters and numbers, the same as the printed booklet. HDMI on Luna shows the same code if you lost the paper. A transfer code from the previous owner goes in this same field.
      </p>
      <form
        className="space-y-5 text-left"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          setLoading(true);
          try {
            const s = await bindCode(code);
            if (isAuthenticated) {
              if (!emailVerified) {
                goTo("verify");
                return;
              }
              await api("/api/v1/onboarding/attach-account", { method: "POST", body: "{}" });
              goTo(s.status === "attached" && s.live ? "name" : "wait");
            } else {
              setAuthSubStep(0);
              goTo("account");
            }
          } catch (err) {
            setError(err.message);
          } finally {
            setLoading(false);
          }
        }}
      >
        <label htmlFor="code" className="block font-mono text-xl text-card-foreground mb-3 leading-snug">
          Device code from the booklet
        </label>
        <Input
          id="code"
          className="font-mono uppercase tracking-widest"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="****-****-****-****-****"
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        {waitMsg && <p className="text-sm text-foreground">{waitMsg}</p>}
        <Button type="submit" size="lg" className="w-full" loading={loading} disabled={code.trim().length < 6}>
          Continue <ArrowRight className="w-4 h-4" />
        </Button>
      </form>
    </StepShell>
  );

  const renderAccount = () => (
    <StepShell
      icon={User}
      title={isLoginMode ? "Welcome back" : path === "oss" ? "Set up your own hardware" : "Create your account"}
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
        </div>
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
        <StepShell icon={User} title="Check your email address">
          <p className="text-muted-foreground text-sm leading-relaxed mb-6 text-pretty">
            We need to verify your email before setup continues. Fix the address here if there is a typo.
          </p>
          <form
            className="space-y-4 text-left"
            onSubmit={async (event) => {
              event.preventDefault();
              setError("");
              setLoading(true);
              try {
                const nextEmail = (email || me?.email || "").trim();
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
            <label htmlFor="signed-in-email" className="block font-mono text-xl text-card-foreground mb-3 leading-snug">
              Email address
            </label>
            <Input
              id="signed-in-email"
              type="email"
              value={email || me?.email || ""}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />
            <Button type="submit" size="lg" className="w-full" loading={loading}>
              {(email || me?.email || "").trim() === me?.email
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
          {path === "oss"
            ? me?.human_verified
              ? "You are already signed in. Continue to get a setup code for this Luna. We will not charge another dollar."
              : "You are already signed in. Next we confirm you are a real person, then give you a setup code for this Luna."
            : "You are already signed in. Continue to connect and name this Luna."}
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
                markEmailVerified?.();
                const account = await refresh();
                await continueAfterVerification(account);
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
                      : "Resend the email"}
                </button>
                .
              </>
            )}
          </p>
        </div>
      </StepShell>
    );
  };

  const renderWait = () => (
    <StepShell icon={Cable} title="Waiting for Luna">
      <p className="text-muted-foreground text-sm leading-relaxed mb-8 text-pretty">
        Keep this page open. Plug Luna into your router or modem with the included RJ45 (ethernet) cable. We continue when Luna comes online.
      </p>
      {waitMsg && <p className="text-sm text-foreground mb-6">{waitMsg}</p>}
      <p className="text-xs font-mono text-muted-foreground animate-pulse">Looking for Luna…</p>
    </StepShell>
  );

  const renderOssCode = () => (
    <StepShell icon={Key} title="Enter this on Luna">
      <p className="font-mono text-xl sm:text-2xl tracking-widest break-all mb-6">{ossCode}</p>
      <p className="text-sm text-foreground mb-8 leading-relaxed">
        On Luna, open the address on the screen and enter this code (same shape as a booklet code: ****-****-****-****-****).
      </p>
      <Button
        size="lg"
        className="w-full"
        onClick={async () => {
          try {
            setError("");
            await bindCode(ossCode);
            goTo("wait");
          } catch (err) {
            setError(err.message);
          }
        }}
      >
        I entered it on Luna
      </Button>
    </StepShell>
  );

  const renderName = () => (
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
            await api("/api/v1/onboarding/attach-account", { method: "POST", body: "{}" });
            const created = await api("/api/v1/onboarding/name", { method: "POST", body: JSON.stringify({ subdomain: name }) });
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
        {waitMsg && <p className="text-sm">{waitMsg}</p>}
        <Button type="submit" size="lg" className="w-full" loading={loading} disabled={name.trim().length < 3}>
          Use this name <ArrowRight className="w-4 h-4" />
        </Button>
      </form>
    </StepShell>
  );

  const renderCopies = () => (
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
          size="lg"
          className="w-full mb-3"
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
      <Button variant="outline" size="lg" className="w-full mt-3" onClick={() => goTo("done")}>
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
        <p className="text-sm text-foreground leading-relaxed">
          The first time you visit that address, create your Luna login there. That login is separate from this Luna Connect account. Paste this one-time code when you create it so only you — the person who just finished setup here — can make that first account. People who only know the address cannot.
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
  if (step === "welcome") body = renderWelcome();
  else if (step === "code") body = renderCode();
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
  } else if (step === "oss-code") body = renderOssCode();
  else if (step === "wait") body = renderWait();
  else if (step === "name") body = renderName();
  else if (step === "copies") body = renderCopies();
  else if (step === "done") body = renderDone();

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
      {step !== "welcome" && step !== "done" && (
        <div className="px-4 pb-8 flex justify-center">
          <Button variant="outline" onClick={handleBack}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        </div>
      )}
    </div>
  );
}
