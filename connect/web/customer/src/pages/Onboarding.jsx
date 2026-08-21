import { useState, useRef, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";

import { Badge } from "../components/ui/badge.jsx";
import { cn } from "../lib/utils.js";
import { copyToClipboard } from "../lib/clipboard.js";
import { useAnimatedHeight } from "../hooks/useAnimatedHeight.js";
import {
  Globe, Shield, Key,
  ChevronRight, ChevronLeft, Copy, Check, Loader2, Search,
  ArrowRight, Sparkles, User, MailOpen,
  X
} from "lucide-react";

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "account", label: "Account" },
  { id: "verify", label: "Verify email" },
  { id: "plan", label: "Plan" },
  { id: "domain", label: "Domain" },
  { id: "key", label: "Key" },
];

function ProgressBar({ step }) {
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
                  : "bg-muted text-muted-foreground"
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
                i === step ? "text-foreground" : "text-muted-foreground"
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

ProgressBar.propTypes = {
  step: PropTypes.number.isRequired,
};

function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div className="rounded-large-element bg-error/10 border-2 border-error/30 p-4 flex items-start gap-3 mb-8 animate-fade-in-up">
      <X className="w-4 h-4 text-error mt-0.5 shrink-0" />
      <p className="text-sm text-error flex-1 leading-relaxed">{error}</p>
      {onDismiss && (
        <button onClick={onDismiss} className="text-error/60 hover:text-error motion-safe:transition-colors" aria-label="Dismiss error">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

ErrorBanner.propTypes = {
  error: PropTypes.string,
  onDismiss: PropTypes.func,
};

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

StepShell.propTypes = {
  icon: PropTypes.elementType.isRequired,
  title: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
  wide: PropTypes.bool,
};

function Field({ label, htmlFor, hint, children }) {
  return (
    <div className="text-left">
      <Label htmlFor={htmlFor} className="mb-2 block">{label}</Label>
      {children}
      {hint && (
        <p className="mt-2.5 text-xs text-muted-foreground leading-relaxed">{hint}</p>
      )}
    </div>
  );
}

Field.propTypes = {
  label: PropTypes.string.isRequired,
  htmlFor: PropTypes.string.isRequired,
  hint: PropTypes.node,
  children: PropTypes.node.isRequired,
};

Field.defaultProps = {
  hint: undefined,
};

// PlanCard — individual plan option with animated height for the Selected indicator.
function PlanCard({ plan, isCurrent, onClick }) {
  const { outerRef, innerRef } = useAnimatedHeight();
  const limits = plan.limits || {};
  const price = plan.price_monthly / 100;
  const isFree = plan.price_monthly === 0;

  return (
    <div
      ref={outerRef}
      className={cn(
        "overflow-hidden transition-[height] ease-[cubic-bezier(0.05,0.7,0.1,1)]",
        "rounded-large-element border-2 motion-safe:transition-all motion-safe:duration-200 cursor-pointer",
        isCurrent
          ? "border-foreground/40 bg-accent"
          : "border-border hover:bg-accent hover:border-foreground/20"
      )}
      style={{ transitionDuration: "300ms" }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
    >
      <div ref={innerRef} className="p-4">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-card-foreground">{plan.name}</span>
            {isFree && (
              <span className="rounded-pill bg-foreground/10 px-2 py-0.5 text-xs text-foreground">
                No card needed
              </span>
            )}
          </div>
          <span className="font-mono text-lg text-card-foreground">
            {isFree ? "Free" : <>${price}<span className="text-xs text-muted-foreground font-sans">/mo</span></>}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mb-2">{plan.description}</p>
        <div className="flex flex-wrap gap-1.5">
          {limits.backup_gb !== undefined && (
            <Badge variant="outline">{limits.backup_gb} GB backup</Badge>
          )}
          {limits.tunnel_gb !== undefined && (
            <Badge variant="outline">{limits.tunnel_gb} GB tunnel</Badge>
          )}
          {limits.smtp_monthly !== undefined && (
            <Badge variant="outline">{limits.smtp_monthly} emails/mo</Badge>
          )}
          {(limits.ai_credit_cents || 0) > 0 && (
            <Badge variant="outline">${(limits.ai_credit_cents / 100).toFixed(0)} AI Support credits</Badge>
          )}
        </div>
        {isCurrent && (
          <div className="flex items-center gap-1.5 mt-2 text-card-foreground animate-in fade-in slide-in-from-bottom-1 duration-200">
            <Check className="w-3.5 h-3.5" />
            <span className="text-xs font-mono">Selected</span>
          </div>
        )}
      </div>
    </div>
  );
}

PlanCard.propTypes = {
  plan: PropTypes.object.isRequired,
  isCurrent: PropTypes.bool.isRequired,
  onClick: PropTypes.func.isRequired,
};

// ─── SubdomainPicker — free subdomain with live preview + availability ─────
function SubdomainPicker({ subdomainName, setSubdomainName, subAvailability, setSubAvailability, checkingSub, suffix, onContinue }) {
  const debounceRef = useRef(null);
  const fullAddress = subdomainName ? `${subdomainName}.${suffix}` : "";

  const handleChange = (e) => {
    const v = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setSubdomainName(v);
    setSubAvailability(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!v || v.length < 3) return;
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.checkSubdomain(v);
        setSubAvailability(res.available);
      } catch {
        setSubAvailability(null);
      }
    }, 400);
  };

  const valid = subdomainName.trim().length >= 3 && subAvailability !== false;

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid) onContinue(); }} className="space-y-4 text-left">
      <Field label="Subdomain name" htmlFor="onb-subdomain">
        <div className="relative">
          <Input
            id="onb-subdomain"
            type="text"
            value={subdomainName}
            onChange={handleChange}
            placeholder="your-name"
            autoFocus
            className="pr-24"
            aria-describedby="subdomain-preview subdomain-status"
          />
          {subdomainName && (
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-mono text-muted-foreground pointer-events-none select-none">
              .{suffix.slice(0, 4)}…
            </span>
          )}
        </div>

        {/* Live preview */}
        {fullAddress && (
          <div
            id="subdomain-preview"
            className={cn(
              "mt-3 rounded-large-element px-4 py-2.5 font-mono text-sm motion-safe:transition-colors",
              subAvailability === true
                ? "bg-success/10 text-success"
                : subAvailability === false
                ? "bg-error/10 text-error"
                : "bg-muted text-foreground"
            )}
          >
            {fullAddress}
          </div>
        )}

        {/* Availability status */}
        {subdomainName && subdomainName.length >= 3 && (
          <p id="subdomain-status" className={cn(
            "mt-2 text-xs font-mono motion-safe:transition-colors",
            subAvailability === true ? "text-success" : subAvailability === false ? "text-error" : "text-muted-foreground"
          )}>
            {checkingSub
              ? "Checking availability…"
              : subAvailability === true
              ? "Available"
              : subAvailability === false
              ? "Already taken — try another"
              : ""}
          </p>
        )}
      </Field>

      <Button type="submit" className="w-full" size="lg" disabled={!valid}>
        Continue <ChevronRight className="w-4 h-4 ml-1" />
      </Button>
    </form>
  );
}

SubdomainPicker.propTypes = {
  subdomainName: PropTypes.string.isRequired,
  setSubdomainName: PropTypes.func.isRequired,
  subAvailability: PropTypes.bool,
  setSubAvailability: PropTypes.func.isRequired,
  checkingSub: PropTypes.bool.isRequired,
  suffix: PropTypes.string.isRequired,
  onContinue: PropTypes.func.isRequired,
};

SubdomainPicker.defaultProps = {
  subAvailability: null,
};

// ─── CustomDomainSection — progressive disclosure for BYO domain ────────────
function CustomDomainSection({
  customDomainQuery, setCustomDomainQuery,
  domainResults,
  purchasingDomain,
  registeredDomain,
  handleSearchDomain, handlePurchaseDomain,
  onContinue,
}) {
  if (registeredDomain) {
    return (
      <div className="text-center space-y-5 animate-fade-in-up">
        <div className="mx-auto w-14 h-14 rounded-full bg-success/20 flex items-center justify-center">
          <Check className="w-7 h-7 text-success animate-check-pop" />
        </div>
        <p className="font-mono text-xl text-card-foreground">{registeredDomain}</p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Your domain is registered. We'll set up the DNS records automatically.
        </p>
        <Button size="lg" className="w-full" onClick={onContinue}>
          Continue <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 text-left animate-fade-in-up">
      <p className="text-xs text-muted-foreground leading-relaxed">
        Get a custom domain — registered at cost through Cloudflare, no markup.
      </p>

      <Field label="Search for a domain" htmlFor="onb-custom-domain">
        <div className="flex gap-2">
          <Input
            id="onb-custom-domain"
            type="text"
            value={customDomainQuery}
            onChange={(e) => setCustomDomainQuery(e.target.value)}
            placeholder="my-site"
            onKeyDown={(e) => { if (e.key === "Enter") handleSearchDomain(); }}
          />
          <Button variant="outline" size="icon" onClick={handleSearchDomain} disabled={!customDomainQuery.trim()}>
            <Search className="w-4 h-4" />
          </Button>
        </div>
      </Field>

      {domainResults.filter((r) => r.available !== false).length > 0 && (
        <div className="space-y-2">
          {domainResults
            .filter((r) => r.available !== false)
            .map((result) => (
              <div
                key={result.name}
                className="flex items-center justify-between rounded-large-element border border-success/30 bg-success/5 px-4 py-3 gap-3"
              >
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-sm text-card-foreground">{result.name}</span>
                  {result.price && (
                    <span className="ml-2 text-xs text-muted-foreground">${result.price}/year</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="success">Available</Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handlePurchaseDomain(result.name)}
                    disabled={purchasingDomain}
                  >
                    {purchasingDomain ? <Loader2 className="w-3 h-3 animate-spin" /> : "Register"}
                  </Button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

CustomDomainSection.propTypes = {
  customDomainQuery: PropTypes.string.isRequired,
  setCustomDomainQuery: PropTypes.func.isRequired,
  domainResults: PropTypes.array.isRequired,
  purchasingDomain: PropTypes.bool.isRequired,
  registeredDomain: PropTypes.string,
  handleSearchDomain: PropTypes.func.isRequired,
  handlePurchaseDomain: PropTypes.func.isRequired,
  onContinue: PropTypes.func.isRequired,
};

CustomDomainSection.defaultProps = {
  registeredDomain: null,
};

const PROGRESS_KEY = "connect-onboarding-progress";

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveProgress(data) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
}

function clearProgress() {
  try { localStorage.removeItem(PROGRESS_KEY); } catch { /* storage unavailable */ }
}

const RESEND_COOLDOWN = 45;

export default function Onboarding() {
  const navigate = useNavigate();
  const { isAuthenticated, login, register, loading: authLoading, account, markEmailVerified, updateAccountEmail } = useAuth();
  const saved = useRef(loadProgress());
  const [step, setStep] = useState(saved.current?.step || 0);
  const [direction, setDirection] = useState("right"); // "right" | "left"
  const [error, setError] = useState("");
  const { outerRef, innerRef } = useAnimatedHeight();

  const [email, setEmail] = useState(saved.current?.email || "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState(saved.current?.name || "");
  const [username, setUsername] = useState(saved.current?.username || "");
  const [isLoginMode, setIsLoginMode] = useState(false);
  const [authSubStep, setAuthSubStep] = useState(0); // 0 name, 1 username, 2 email, 3 password
  const [authSubDir, setAuthSubDir] = useState("right");

  const [resendState, setResendState] = useState("idle"); // idle | sending | sent
  const [cooldown, setCooldown] = useState(0);
  const [emailVerified, setEmailVerified] = useState(false);
  const [checkingVerification, setCheckingVerification] = useState(false);

  // Poll verification status while on the verify step — the step is a hard
  // blocker, so as soon as the user clicks the email link (in any tab), we
  // detect it here and unlock.
  useEffect(() => {
    if (step !== 2 || emailVerified) return;
    let cancelled = false;
    const check = () => {
      api.getVerificationStatus()
        .then((res) => {
          if (!cancelled && res.email_verified) {
            setEmailVerified(true);
            markEmailVerified();
          }
        })
        .catch(() => {});
    };
    check();
    const interval = setInterval(check, 4000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [step, emailVerified, markEmailVerified]);

  const [selectedPlan, setSelectedPlan] = useState(saved.current?.selectedPlan || null);

  const [subdomainName, setSubdomainName] = useState(saved.current?.subdomainName || "");
  const [subAvailability, setSubAvailability] = useState(null); // null | true | false
  const [checkingSub, setCheckingSub] = useState(false);
  const [customDomainOpen, setCustomDomainOpen] = useState(false);
  const [customDomainQuery, setCustomDomainQuery] = useState("");
  const [domainResults, setDomainResults] = useState([]);
  const [purchasingDomain, setPurchasingDomain] = useState(false);
  const [registeredDomain, setRegisteredDomain] = useState(saved.current?.registeredDomain || null);

  const [connectKey, setConnectKey] = useState(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  // Detect Stripe checkout return (success or cancelled) on mount.
  // After payment, Stripe redirects here — advance to domain step (4).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkoutStatus = params.get("checkout");
    const domainStatus = params.get("domain");
    if (checkoutStatus === "success") {
      window.history.replaceState({}, "", "/onboarding");
      const saved = loadProgress();
      if (saved && saved.step >= 3) {
        setStep(4);
        setDirection("right");
      }
    } else if (checkoutStatus === "cancelled") {
      window.history.replaceState({}, "", "/onboarding");
      setError("Payment was cancelled. You can try again or choose the Free plan.");
    } else if (domainStatus === "success") {
      window.history.replaceState({}, "", "/onboarding");
      const saved = loadProgress();
      if (saved && saved.step >= 4) {
        setStep(5);
        setDirection("right");
      }
    } else if (domainStatus === "cancelled") {
      window.history.replaceState({}, "", "/onboarding");
      setError("Domain registration was cancelled. You can try again or skip to the next step.");
    }
  }, []);

  // Persist progress whenever relevant state changes
  useEffect(() => {
    if (step === 0 && !email) return; // don't save empty state
    saveProgress({ step, email, name, username, selectedPlan, subdomainName, registeredDomain });
  }, [step, email, name, username, selectedPlan, subdomainName, registeredDomain]);


  const { data: plansData } = useQuery({
    queryKey: ["plans"],
    queryFn: () => api.getPlans(),
  });
  const plans = plansData?.plans || [];
  const loadingPlans = !plansData;

  const currentPlan = selectedPlan ? plans.find((p) => p.id === selectedPlan) : null;
  // Plans are named "Connect Free" etc. — detect free by price, not name.
  const isFreePlan = currentPlan ? currentPlan.price_monthly === 0 : false;

  const clearError = () => setError("");

  // Resend cooldown ticker
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Auto-generate the connect key when the user reaches the key step.
  // The key step is the last step. We generate once — the guard
  // prevents duplicate calls on re-renders. The subdomain the user picked
  // earlier is stamped on the key so the device gets it on activation.
  const keyStep = STEPS.length - 1;
  useEffect(() => {
    if (step !== keyStep || connectKey || generatingKey) return;
    setGeneratingKey(true);
    clearError();
    api.generateConnectKey(subdomainName.trim() || undefined)
      .then((res) => setConnectKey(res.connect_key))
      .catch((err) => setError(err.message || "Could not generate your Connect key. Try again."))
      .finally(() => setGeneratingKey(false));
  }, [step, connectKey, generatingKey, keyStep, subdomainName]);

  const handlePlanContinue = async () => {
    clearError();
    const plan = plans.find((p) => p.id === selectedPlan);
    if (plan && plan.price_monthly > 0) {
      // Paid plan — redirect to Stripe checkout
      setCheckoutLoading(true);
      try {
        const res = await api.createCheckout(selectedPlan);
        if (res.checkout_url && res.checkout_url !== "#") {
          window.location.href = res.checkout_url;
          return;
        }
        // No checkout URL — fall through to next step
      } catch (err) {
        setError(err.message || "We couldn't start the payment process. Try again, or choose the Free plan for now and upgrade later from your dashboard.");
        setCheckoutLoading(false);
        return;
      }
    }
    // Free plan or checkout disabled — proceed to next step
    goNext();
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    clearError();
    try {
      if (isLoginMode) {
        const res = await login(email, password);
        // Existing accounts that already verified skip the verify step.
        if (res && res.email_verified) {
          setStep(3); // plan step
        } else {
          goNext();
        }
      } else {
        // Register returns a token — auto sign-in (no separate login call)
        await register(email, password, name, username, "onboarding");
        goNext();
      }
    } catch (err) {
      // The user went Back from the verify step (typo fix) and re-submitted.
      // The account already exists — update its address instead of failing.
      if (!isLoginMode && isAuthenticated && /already exists/i.test(err.message || "")) {
        try {
          if (email.trim().toLowerCase() !== account?.email?.toLowerCase()) {
            await api.updateEmail(email.trim(), "onboarding");
            updateAccountEmail(email.trim());
          }
          goNext();
          return;
        } catch (fixErr) {
          setError(fixErr.message || "Could not update your email. Try again in a moment.");
          return;
        }
      }
      setError(err.message || "Could not sign in. Check your details and try again.");
    }
  };

  const handleResend = useCallback(async () => {
    if (cooldown > 0 || resendState === "sending") return;
    clearError();
    setResendState("sending");
    try {
      await api.resendVerification("onboarding");
      setResendState("sent");
      setCooldown(RESEND_COOLDOWN);
      setTimeout(() => setResendState("idle"), 3000);
    } catch (err) {
      setError(err.message || "We couldn't send the verification email. Try again in a moment.");
      setResendState("idle");
    }
  }, [cooldown, resendState]);

  // If the account object updates to verified while the user is on the
  // verify step (e.g. they clicked the email link in another tab and then
  // re-authenticated), reflect it.
  useEffect(() => {
    if (account?.email_verified) setEmailVerified(true);
  }, [account]);

  const handleGenerateKey = async () => {
    setGeneratingKey(true);
    clearError();
    try {
      // Stamp the subdomain the user picked on the key so the device's
      // registered free subdomain comes from the onboarding choice, not a
      // random device-ID suffix.
      const res = await api.generateConnectKey(subdomainName.trim() || undefined);
      setConnectKey(res.connect_key);
    } catch (err) {
      setError(err.message || "Could not generate your Connect key. Try again.");
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleSearchDomain = async () => {
    if (!customDomainQuery.trim()) return;
    clearError();
    try {
      const res = await api.searchDomains(customDomainQuery);
      const domains = (res.domains || res.results || []).map((d) => ({
        name: d.name,
        available: d.registrable,
        price: d.registration_cost ? parseFloat(d.registration_cost).toFixed(2) : null,
      }));
      setDomainResults(domains);
    } catch (err) {
      setError(err.message || "Could not search domains.");
    }
  };

  const handlePurchaseDomain = async (domain) => {
    setPurchasingDomain(true);
    clearError();
    try {
      await api.registerDomain("", domain);
      setRegisteredDomain(domain);
    } catch (err) {
      setError(err.message || "Could not register domain. Try again.");
    } finally {
      setPurchasingDomain(false);
    }
  };

  const handleCopy = async (text) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const goNext = () => { setDirection("right"); setStep((s) => s + 1); };
  const goPrev = () => { setDirection("left"); setStep((s) => s - 1); };
  const goBack = () => navigate("/");
  const handleBack = step === 0 ? goBack : goPrev;

  // Reset the account substep flow when leaving/re-entering the account step.
  // Coming back from the verify step (typo fix) jumps straight to the email
  // question — that's why the user went back.
  const prevStepRef = useRef(step);
  useEffect(() => {
    if (prevStepRef.current === step) return;
    const cameFrom = prevStepRef.current;
    prevStepRef.current = step;
    if (step === 1) {
      setAuthSubStep(cameFrom === 2 ? Math.max(authFields.length - 2, 0) : 0);
      setAuthSubDir(cameFrom === 2 ? "left" : "right");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ===== Step Renderers =====

  const renderWelcome = () => (
    <StepShell icon={Sparkles} title="Set up LibreServ Connect">
      <div className="w-full max-w-md mx-auto space-y-4 mb-10">
        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
          <span className="font-mono text-card-foreground">LibreServ</span> is the
          server that runs on your own device at home. Your apps and data stay
          with you.
        </p>
        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
          <span className="font-mono text-card-foreground">Connect</span> is the
          cloud companion. It gives your server a domain (like yourserver.com),
          email, access from anywhere, cloud backup, real human support, and
          more.
        </p>
      </div>
      <Button size="lg" onClick={goNext} className="w-full max-w-sm">
        Get started <ArrowRight className="w-5 h-5 ml-1" />
      </Button>
    </StepShell>
  );

  // ===== Account substep flow (Typeform-style: one question per screen) =====

  const authFields = isLoginMode
    ? [
        {
          id: "onb-email",
          question: "What's your email address?",
          hint: "The one you signed up with.",
          value: email,
          setValue: setEmail,
          type: "email",
          placeholder: "you@example.com",
          autoComplete: "username",
          valid: email.trim().length > 0,
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
          id: "onb-name",
          question: "First, what should we call you?",
          hint: "This is just how we greet you in your dashboard.",
          value: name,
          setValue: setName,
          type: "text",
          placeholder: "Jane Doe",
          autoComplete: "name",
          valid: true, // optional
        },
        {
          id: "onb-username",
          question: "Pick a name for your account",
          hint: (
            <>
              When your apps send email (like password resets or notifications), the
              "from" address will be{" "}
              <span className="font-mono text-card-foreground">{username || "your-name"}-u@resend.libreloom.org</span>.
              This is like the return address on a letter — it tells recipients who it came
              from. Use letters, numbers, and hyphens (3-30 characters).
            </>
          ),
          value: username,
          setValue: (v) => setUsername(v.toLowerCase().replace(/[^a-z0-9-]/g, "")),
          type: "text",
          placeholder: "jane-doe",
          autoComplete: "off",
          valid: /^[a-z0-9-]{3,30}$/.test(username),
        },
        {
          id: "onb-email",
          question: "What's your email address?",
          hint: "This is how you sign in and how we reach you about your device. We send one verification email — that's it.",
          value: email,
          setValue: setEmail,
          type: "email",
          placeholder: "you@example.com",
          autoComplete: "username",
          valid: /^\S+@\S+\.\S+$/.test(email),
        },
        {
          id: "onb-password",
          question: "Choose a password",
          hint: "Use at least 8 characters with a mix of letters, numbers, and symbols.",
          value: password,
          setValue: setPassword,
          type: "password",
          placeholder: "At least 8 characters",
          autoComplete: "new-password",
          valid: password.length >= 8,
        },
      ];

  const currentAuthField = authFields[authSubStep] || authFields[0];
  const isLastAuthSubStep = authSubStep === authFields.length - 1;

  const goSubNext = () => {
    setAuthSubDir("right");
    setAuthSubStep((s) => Math.min(s + 1, authFields.length - 1));
  };
  const goSubPrev = () => {
    setAuthSubDir("left");
    setAuthSubStep((s) => Math.max(s - 1, 0));
  };

  const handleAuthSubSubmit = (e) => {
    e.preventDefault();
    if (!currentAuthField.valid) return;
    if (isLastAuthSubStep) {
      handleAuth(e);
    } else {
      goSubNext();
    }
  };

  const renderAuth = () => (
    <StepShell icon={User} title={isLoginMode ? "Welcome back" : "Create your account"}>
      {/* Substep progress: "2 of 4" with segmented bar */}
      <div className="w-full max-w-sm mx-auto mb-10">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-xs font-mono text-muted-foreground">
            {authSubStep + 1} of {authFields.length}
          </span>
          <button
            type="button"
            onClick={() => { setIsLoginMode(!isLoginMode); setError(""); setAuthSubStep(0); setAuthSubDir("left"); }}
            className="text-xs text-muted-foreground hover:text-card-foreground underline underline-offset-4 motion-safe:transition-colors"
          >
            {isLoginMode ? "Need an account? Register" : "Already have an account? Sign in"}
          </button>
        </div>
        <div className="flex gap-1.5">
          {authFields.map((f, i) => (
            <div key={f.id + i} className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-foreground motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.05,0.7,0.1,1)]"
                style={{ width: i < authSubStep ? "100%" : i === authSubStep ? "100%" : "0%", opacity: i <= authSubStep ? 1 : 0 }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* One question per screen — key remounts on substep change for slide animation */}
      <form onSubmit={handleAuthSubSubmit} className="w-full max-w-sm mx-auto text-left">
        <div
          key={`${isLoginMode ? "login" : "register"}-${authSubStep}`}
          className={cn(authSubDir === "left" ? "slide-in-from-left-pop" : "slide-in-from-right-pop")}
          style={{ animationDuration: "300ms", animationFillMode: "both" }}
        >
          <label
            htmlFor={currentAuthField.id}
            className="block font-mono text-xl text-card-foreground mb-5 leading-snug"
          >
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
            className="h-14 text-lg px-5"
          />
          {currentAuthField.hint && (
            <p className="mt-4 text-xs text-muted-foreground leading-relaxed">
              {currentAuthField.hint}
            </p>
          )}

          <div className="flex items-center gap-3 mt-8">
            {authSubStep > 0 && (
              <Button type="button" variant="outline" size="lg" onClick={goSubPrev} className="shrink-0">
                <ChevronLeft className="w-4 h-4" />
              </Button>
            )}
            <Button
              type="submit"
              size="lg"
              className="flex-1"
              disabled={!currentAuthField.valid}
              loading={isLastAuthSubStep && authLoading}
            >
              {isLastAuthSubStep
                ? isLoginMode ? "Sign in" : "Create account and sign in"
                : "Continue"}
              {!isLastAuthSubStep && <ChevronRight className="w-4 h-4 ml-1" />}
            </Button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground text-center">
            press <kbd className="font-mono text-card-foreground bg-muted rounded-md px-1.5 py-0.5">Enter</kbd> to continue
          </p>
        </div>
      </form>
    </StepShell>
  );

  const renderVerifyEmail = () => {
    if (emailVerified) {
      return (
        <div className="flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center mb-6 animate-step-icon">
            <Check className="w-8 h-8 text-success animate-check-pop" />
          </div>
          <h1 className="font-mono text-[1.75rem] leading-snug font-normal text-card-foreground tracking-tight mb-3">
            Email verified
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-md mx-auto mb-8">
            <span className="font-mono text-card-foreground">{email}</span> is confirmed.
            You're all set — on to the next step.
          </p>
          <Button size="lg" className="w-full max-w-sm" onClick={goNext}>
            Continue <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      );
    }

    const handleManualCheck = async () => {
      setCheckingVerification(true);
      clearError();
      try {
        const res = await api.getVerificationStatus();
        if (res.email_verified) {
          setEmailVerified(true);
          markEmailVerified();
        } else {
          setError("We don't see the verification yet. Click the link in the email first, then try again — or resend it below.");
        }
      } catch {
        setError("Couldn't check your verification status. Try again in a moment.");
      } finally {
        setCheckingVerification(false);
      }
    };

    return (
      <StepShell icon={MailOpen} title="Check your inbox">
        <p className="text-muted-foreground text-sm leading-relaxed max-w-md mx-auto mb-8">
          We sent a verification link to{" "}
          <span className="font-mono text-card-foreground">{email}</span>. Open
          the email from LibreServ Connect and click{" "}
          <span className="font-mono text-card-foreground">Verify my email</span>{" "}
          — this page unlocks by itself when you're done.
        </p>

        <div className="w-full max-w-sm mx-auto space-y-6 animate-fade-in-up">
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Waiting for verification…
          </div>

          <div className="flex items-center gap-3">
            {/* Circular back chevron — same pattern as the account substeps.
                Going back re-opens the account form; re-submitting there
                updates the existing account instead of failing (handleAuth). */}
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={goPrev}
              aria-label="Go back"
              className="shrink-0"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button size="lg" className="flex-1" onClick={handleManualCheck} loading={checkingVerification}>
              Check again
            </Button>
          </div>

          <p className="text-center text-sm text-muted-foreground">
            {resendState === "sent" ? (
              "Verification email sent — check your inbox (and spam folder)."
            ) : (
              <>
                Didn't get it? Check your spam folder, or{" "}
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={cooldown > 0 || resendState === "sending"}
                  className="underline underline-offset-2 hover:text-card-foreground motion-safe:transition-colors disabled:opacity-60 disabled:pointer-events-none"
                >
                  {resendState === "sending"
                    ? "sending…"
                    : cooldown > 0
                    ? `resend in ${cooldown}s`
                    : "resend the email"}
                </button>
                .
              </>
            )}
          </p>
        </div>
      </StepShell>
    );
  };

  const renderPlan = () => {
    if (loadingPlans) {
      return (
        <div className="flex flex-col items-center text-center py-8">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mb-4" />
          <p className="text-muted-foreground text-sm">Loading plans…</p>
        </div>
      );
    }

    return (
      <StepShell icon={Shield} title="Choose a plan">
        <p className="text-muted-foreground text-sm leading-relaxed max-w-md mx-auto mb-8">
          Pick what fits your needs. You can change or cancel anytime.
        </p>

        <div className="w-full max-w-sm mx-auto space-y-3">
          {plans.map((plan, i) => (
            <div key={plan.id} className="animate-fade-in-up" style={{ animationDelay: `${i * 70}ms` }}>
              <PlanCard
                plan={plan}
                isCurrent={selectedPlan === plan.id}
                onClick={() => setSelectedPlan(plan.id)}
              />
            </div>
          ))}
        </div>

        {selectedPlan && !isFreePlan && (
          <div className="w-full max-w-sm mx-auto mt-5 rounded-large-element border border-border bg-muted p-4 text-left animate-in fade-in slide-in-from-bottom-2 duration-300">
            <p className="text-xs text-muted-foreground">
              You'll complete payment through Stripe on the next screen.
            </p>
          </div>
        )}

        <div className="w-full max-w-sm mx-auto mt-8">
          <Button size="lg" className="w-full" disabled={!selectedPlan} loading={checkoutLoading} onClick={handlePlanContinue}>
            {isFreePlan ? "Continue" : "Continue to Payment"} <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      </StepShell>
    );
  };

  const renderDomain = () => {
    if (isFreePlan) return renderFreeDomain();
    return renderPaidDomain();
  };

  // Suffix shown in the subdomain preview: the plan's wildcard domain pattern
  // (e.g. "*.servers.libreloom.org") minus the "*.", e.g. "servers.libreloom.org".
  // Fall back to the hardcoded legacy values if the plan hasn't loaded yet.
  const domainSuffix = (currentPlan?.limits?.domain || "").replace(/^\*\./, "") || "servers.libreloom.org";

  const renderPaidDomain = () => (
    <StepShell icon={Globe} title="Choose your domain">
      <p className="text-muted-foreground text-sm leading-relaxed max-w-md mx-auto mb-2">
        This is the address people use to reach your apps.
        Pick a free subdomain now — you can always change it later from your dashboard.
      </p>

      {/* Free subdomain — the default, always visible */}
      <div className="w-full max-w-sm mx-auto">
        <SubdomainPicker
          subdomainName={subdomainName}
          setSubdomainName={setSubdomainName}
          subAvailability={subAvailability}
          setSubAvailability={setSubAvailability}
          checkingSub={checkingSub}
          suffix={domainSuffix}
          onContinue={() => { if (subdomainName.trim() && subAvailability !== false) goNext(); }}
        />
      </div>

      {/* Custom domain — progressive disclosure */}
      <div className="w-full max-w-sm mx-auto mt-8">
        {!customDomainOpen ? (
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-4 motion-safe:transition-colors"
            onClick={() => setCustomDomainOpen(true)}
          >
            Or get a custom domain instead
          </button>
        ) : (
          <CustomDomainSection
            customDomainQuery={customDomainQuery}
            setCustomDomainQuery={setCustomDomainQuery}
            domainResults={domainResults}
            purchasingDomain={purchasingDomain}
            registeredDomain={registeredDomain}
            handleSearchDomain={handleSearchDomain}
            handlePurchaseDomain={handlePurchaseDomain}
            onContinue={goNext}
          />
        )}
      </div>

      {/* Skip */}
      <div className="w-full max-w-sm mx-auto mt-6">
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4 motion-safe:transition-colors"
          onClick={goNext}
        >
          Skip for now — set up later
        </button>
      </div>
    </StepShell>
  );



  const renderFreeDomain = () => (
    <StepShell icon={Globe} title="Pick your free domain">
      <p className="text-muted-foreground text-sm leading-relaxed max-w-md mx-auto mb-2">
        This is the address people use to reach your apps.
        You can always change it later from your dashboard.
      </p>

      <div className="w-full max-w-sm mx-auto">
        <SubdomainPicker
          subdomainName={subdomainName}
          setSubdomainName={setSubdomainName}
          subAvailability={subAvailability}
          setSubAvailability={setSubAvailability}
          checkingSub={checkingSub}
          suffix={domainSuffix}
          onContinue={() => { if (subdomainName.trim() && subAvailability !== false) goNext(); }}
        />
      </div>
    </StepShell>
  );


  const renderConnectKey = () => (
    <StepShell icon={Key} title="Your Connect key">
      <p className="text-muted-foreground text-sm leading-relaxed max-w-md mx-auto mb-8">
        Almost done! Copy this key and paste it back into the LibreServ setup
        page you came from.
      </p>

      {generatingKey && !connectKey ? (
        <div className="flex flex-col items-center gap-4 py-4">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Generating your key…</p>
        </div>
      ) : connectKey ? (
        <div className="w-full max-w-sm mx-auto space-y-8">
          <div className="rounded-large-element bg-muted border border-border p-5 animate-fade-in-up">
            <div className="flex items-center gap-3">
              <Key className="w-5 h-5 text-muted-foreground shrink-0" />
              <code className="text-base font-mono flex-1 break-all select-all text-foreground text-left">
                {connectKey}
              </code>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleCopy(connectKey)}
                title="Copy to clipboard"
              >
                {copied ? <Check className="w-4 h-4 text-success animate-check-pop" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
          </div>

          <div className="text-left space-y-3">
            <h3 className="font-mono text-sm text-card-foreground">Next steps:</h3>
            <ol className="space-y-2.5 text-sm text-muted-foreground">
              <li className="flex gap-2.5">
                <span className="font-mono text-card-foreground">1.</span>
                Copy the key above
              </li>
              <li className="flex gap-2.5">
                <span className="font-mono text-card-foreground">2.</span>
                Return to the LibreServ setup page on your device
              </li>
              <li className="flex gap-2.5">
                <span className="font-mono text-card-foreground">3.</span>
                Paste the key and click Activate
              </li>
            </ol>
          </div>

          <Button size="lg" className="w-full" onClick={() => { clearProgress(); navigate("/"); }}>
            Done <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-4">
          <p className="text-sm text-muted-foreground">Something went wrong. Try again.</p>
          <Button size="lg" variant="outline" onClick={handleGenerateKey}>
            Retry
          </Button>
        </div>
      )}
    </StepShell>
  );

  const stepComponents = [renderWelcome, renderAuth, renderVerifyEmail, renderPlan, renderDomain, renderConnectKey];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <ProgressBar step={step} />

      <div className="flex-1 flex items-start sm:items-center justify-center px-4 pb-8">
        <div
          ref={outerRef}
          className="w-full max-w-xl rounded-large-element border border-border bg-card text-card-foreground shadow-[0_32px_80px_rgba(0,0,0,0.12)] overflow-hidden transition-[height] ease-[cubic-bezier(0.05,0.7,0.1,1)]"
          style={{ transitionDuration: "300ms" }}
        >
          <div ref={innerRef} className="px-6 sm:px-12 py-12">
            <ErrorBanner error={error} onDismiss={clearError} />
            <div key={step} className={cn(direction === "left" ? "slide-in-from-left-pop" : "slide-in-from-right-pop")} style={{ animationDuration: "300ms", animationFillMode: "both" }}>
              {stepComponents[step]?.()}
            </div>
          </div>
        </div>
      </div>

      {/* Verify handles back navigation inline (circular chevron beside the
          action button); the account step re-submit updates the existing
          account — see handleAuth. */}
      {step > 0 && step < STEPS.length && STEPS[step].id !== "verify" && (
        <div className="px-4 pb-8 flex justify-center">
          <Button variant="outline" onClick={handleBack}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        </div>
      )}
    </div>
  );
}
