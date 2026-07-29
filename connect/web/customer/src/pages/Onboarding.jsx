import { useState, useRef, useEffect } from "react";
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
import { useAnimatedHeight } from "../hooks/useAnimatedHeight.js";
import {
  Globe, Shield, Key,
  ChevronRight, ChevronLeft, Copy, Check, Loader2, Search,
  ArrowRight, ArrowLeft, Sparkles, User,
  X
} from "lucide-react";
const STEP_LABELS = ["Welcome", "Account", "Plan", "Domain", "Key"];

function ProgressBar({ step }) {
  return (
    <div className="flex items-center justify-center gap-1 pt-8 pb-6">
      {STEP_LABELS.map((label, i) => (
        <div key={label} className="flex items-center">
          <div
            className={cn(
              "flex items-center justify-center w-8 h-8 rounded-full text-xs font-mono motion-safe:transition-colors",
              i < step
                ? "bg-foreground/15 text-foreground"
                : i === step
                ? "bg-foreground text-background ring-2 ring-ring"
                : "bg-muted text-muted-foreground"
            )}
            title={label}
          >
            {i < step ? <Check className="w-4 h-4" /> : i + 1}
          </div>
          {i < STEP_LABELS.length - 1 && (
            <div
              className={cn(
                "w-6 sm:w-10 h-0.5 mx-0.5 motion-safe:transition-colors",
                i < step ? "bg-foreground/30" : "bg-muted"
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function ErrorBanner({ error, onDismiss }) {
  if (!error) return null;
  return (
    <div className="rounded-large-element bg-error/10 border-2 border-error/30 p-3 flex items-start gap-2 mb-6">
      <X className="w-4 h-4 text-error mt-0.5 shrink-0" />
      <p className="text-sm text-error flex-1">{error}</p>
      {onDismiss && (
        <button onClick={onDismiss} className="text-error/60 hover:text-error motion-safe:transition-colors">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

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
            <Badge variant="outline">${(limits.ai_credit_cents / 100).toFixed(0)} AI credit</Badge>
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


const PROGRESS_KEY = "connect-onboarding-progress";

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveProgress(data) {
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(data)); } catch {}
}

function clearProgress() {
  try { localStorage.removeItem(PROGRESS_KEY); } catch {}
}

export default function Onboarding() {
  const navigate = useNavigate();
  const { login, register } = useAuth();
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


  const [selectedPlan, setSelectedPlan] = useState(saved.current?.selectedPlan || null);

  const [subdomainName, setSubdomainName] = useState(saved.current?.subdomainName || "");
  const [domainMode, setDomainMode] = useState(saved.current?.domainMode || "subdomain");
  const [customDomainQuery, setCustomDomainQuery] = useState("");
  const [domainResults, setDomainResults] = useState([]);
  const [checkingDomain, setCheckingDomain] = useState(null);
  const [purchasingDomain, setPurchasingDomain] = useState(false);
  const [registeredDomain, setRegisteredDomain] = useState(saved.current?.registeredDomain || null);

  const [connectKey, setConnectKey] = useState(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  // Persist progress whenever relevant state changes
  useEffect(() => {
    if (step === 0 && !email) return; // don't save empty state
    saveProgress({ step, email, name, username, selectedPlan, subdomainName, domainMode, registeredDomain });
  }, [step, email, name, username, selectedPlan, subdomainName, domainMode, registeredDomain]);


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

  // Auto-generate the connect key when the user reaches the key step.
  // The key step is the last step (index 4). We generate once — the guard
  // prevents duplicate calls on re-renders.
  const keyStep = 4; // renderConnectKey index in stepComponents
  useEffect(() => {
    if (step !== keyStep || connectKey || generatingKey) return;
    setGeneratingKey(true);
    clearError();
    api.generateConnectKey()
      .then((res) => setConnectKey(res.connect_key))
      .catch((err) => setError(err.message || "Could not generate your Connect key. Try again."))
      .finally(() => setGeneratingKey(false));
  }, [step, connectKey, generatingKey]);

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
        await login(email, password);
      } else {
        // Register now returns a token — auto sign-in (no separate login call)
        await register(email, password, name, username);
      }
      setStep(1);
    } catch (err) {
      setError(err.message || "Could not sign in. Check your details and try again.");
    }
  };

  const handleGenerateKey = async () => {
    setGeneratingKey(true);
    clearError();
    try {
      const res = await api.generateConnectKey();
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
      setDomainResults(res.domains || res.results || []);
    } catch (err) {
      setError(err.message || "Could not search domains.");
    }
  };

  const handleCheckDomain = async (domain) => {
    setCheckingDomain(domain);
    clearError();
    try {
      const res = await api.checkDomain(domain);
      setDomainResults((prev) =>
        prev.map((d) => (d.name === domain ? { ...d, available: res.available } : d))
      );
    } catch (err) {
      setError(err.message || "Could not check availability.");
    } finally {
      setCheckingDomain(null);
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

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const goNext = () => { setDirection("right"); setStep((s) => s + 1); };
  const goPrev = () => { setDirection("left"); setStep((s) => s - 1); };
  const goBack = () => navigate("/");
  const handleBack = step === 0 ? goBack : goPrev;

  // ===== Step Renderers =====

  const renderWelcome = () => (
    <div className="flex flex-col items-center text-center py-4">
      <Sparkles size={48} className="text-muted-foreground mx-auto mb-4" />
      <h1 className="font-mono text-3xl font-normal text-card-foreground tracking-tight mb-3">
        Set up LibreServ Connect
      </h1>
      <p className="text-muted-foreground text-sm leading-relaxed max-w-md mb-8">
        Connect gives your LibreServ device a domain name, email, remote access,
        and cloud backup — all wired up in one signup.
      </p>
      <Button size="lg" onClick={goNext}>
        Get started <ArrowRight className="w-5 h-5 ml-1" />
      </Button>
    </div>
  );

  const renderAuth = () => (
    <div className="flex flex-col items-center text-center py-4">
      <User size={48} className="text-muted-foreground mx-auto mb-4" />
      <h1 className="font-mono text-3xl font-normal text-card-foreground tracking-tight mb-3">
        {isLoginMode ? "Welcome back" : "Create your account"}
      </h1>
      <p className="text-muted-foreground text-sm leading-relaxed max-w-md mb-6">
        {isLoginMode
          ? "Sign in to your LibreServ Connect account."
          : "Your email is how you access your dashboard and manage your device."}
      </p>

      <form onSubmit={handleAuth} className="w-full max-w-sm space-y-4 text-left">
        {!isLoginMode && (
          <div>
            <Label htmlFor="onb-name">Your name</Label>
            <Input
              id="onb-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Doe"
            />
          </div>
        )}
        {!isLoginMode && (
          <div>
            <Label htmlFor="onb-username">Pick a name for your account</Label>
            <Input
              id="onb-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              placeholder="jane-doe"
              autoComplete="off"
            />
            <p className="mt-1.5 text-xs text-muted-foreground">
              When your apps send email (like password resets or notifications), the
              "from" address will be{" "}
              <span className="font-mono">{username || "your-name"}@resend.libreloom.org</span>.
              This is like the return address on a letter — it tells recipients who it came from.
              Use letters, numbers, and hyphens (3-30 characters).
            </p>
          </div>
        )}
        <div>
          <Label htmlFor="onb-email">Email address</Label>
          <Input
            id="onb-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoFocus
            autoComplete="username"
          />
        </div>
        <div>
          <Label htmlFor="onb-password">Password</Label>
          <Input
            id="onb-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete={isLoginMode ? "current-password" : "new-password"}
          />
          {!isLoginMode && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Use at least 8 characters with a mix of letters, numbers, and symbols.
            </p>
          )}
        </div>

        <Button type="submit" className="w-full" size="lg">
          {isLoginMode ? "Sign in" : "Create account and sign in"}
        </Button>
      </form>

      <button
        type="button"
        onClick={() => { setIsLoginMode(!isLoginMode); setError(""); }}
        className="text-sm text-muted-foreground hover:text-card-foreground mt-4 underline motion-safe:transition-colors"
      >
        {isLoginMode ? "Need an account? Register" : "Already have an account? Sign in"}
      </button>
    </div>
  );



  const renderPlan = () => {
    if (loadingPlans) {
      return (
        <div className="flex flex-col items-center text-center py-4">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mb-4" />
          <p className="text-muted-foreground text-sm">Loading plans…</p>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center text-center py-4">
        <Shield size={48} className="text-muted-foreground mx-auto mb-4" />
        <h1 className="font-mono text-3xl font-normal text-card-foreground tracking-tight mb-3">
          Choose a plan
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed max-w-md mb-6">
          Pick what fits your needs. You can change or cancel anytime.
        </p>

        <div className="w-full max-w-sm space-y-2.5">
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              isCurrent={selectedPlan === plan.id}
              onClick={() => setSelectedPlan(plan.id)}
            />
          ))}
        </div>

        {selectedPlan && !isFreePlan && (
          <div className="w-full max-w-sm mt-4 rounded-large-element border border-border bg-muted p-4 text-left animate-in fade-in slide-in-from-bottom-2 duration-300">
            <p className="text-xs text-muted-foreground">
              You'll complete payment through Stripe on the next screen.
            </p>
          </div>
        )}

        <div className="w-full max-w-sm mt-6">
          <Button size="lg" className="w-full" disabled={!selectedPlan} loading={checkoutLoading} onClick={handlePlanContinue}>
            {isFreePlan ? "Continue" : "Continue to Payment"} <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      </div>
    );
  };

  const renderDomain = () => {
    if (isFreePlan) return renderFreeDomain();
    return renderPaidDomain();
  };

  const renderPaidDomain = () => (
    <div className="flex flex-col items-center text-center py-4">
      <Globe size={48} className="text-muted-foreground mx-auto mb-4" />
      <h1 className="font-mono text-3xl font-normal text-card-foreground tracking-tight mb-3">
        Choose your domain
      </h1>
      <p className="text-muted-foreground text-sm leading-relaxed max-w-md mb-6">
        Pick a free subdomain or buy a custom domain at cost through Cloudflare.
      </p>

      {/* Toggle */}
      <div className="w-full max-w-sm flex bg-muted rounded-pill p-1 mb-6">
        <button
          type="button"
          className={cn(
            "flex-1 py-2 px-4 rounded-pill text-sm font-mono motion-safe:transition-colors",
            domainMode === "subdomain"
              ? "bg-card text-card-foreground shadow-sm"
              : "text-muted-foreground hover:text-card-foreground"
          )}
          onClick={() => { setDomainMode("subdomain"); setDomainResults([]); setRegisteredDomain(null); setError(""); }}
        >
          Free subdomain
        </button>
        <button
          type="button"
          className={cn(
            "flex-1 py-2 px-4 rounded-pill text-sm font-mono motion-safe:transition-colors",
            domainMode === "custom"
              ? "bg-card text-card-foreground shadow-sm"
              : "text-muted-foreground hover:text-card-foreground"
          )}
          onClick={() => { setDomainMode("custom"); setSubdomainName(""); setError(""); }}
        >
          Custom domain
        </button>
      </div>

      {domainMode === "subdomain" && (
        <form
          onSubmit={(e) => { e.preventDefault(); if (subdomainName.trim()) goNext(); }}
          className="w-full max-w-sm space-y-4 text-left"
        >
          <div>
            <Label htmlFor="onb-paid-subdomain">Subdomain name</Label>
            <Input
              id="onb-paid-subdomain"
              type="text"
              value={subdomainName}
              onChange={(e) => setSubdomainName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              placeholder="your-name"
              autoFocus
            />
            {subdomainName && (
              <p className="mt-2 text-sm font-mono text-foreground bg-muted rounded-large-element px-3 py-2">
                {subdomainName}.servers.libreloom.org
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" size="lg" disabled={!subdomainName.trim()}>
            Continue <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </form>
      )}

      {domainMode === "custom" && (
        <div className="w-full max-w-sm space-y-4 text-left">
          {registeredDomain ? (
            <div className="text-center space-y-4">
              <div className="mx-auto w-14 h-14 rounded-full bg-success/20 flex items-center justify-center">
                <Check className="w-7 h-7 text-success" />
              </div>
              <p className="font-mono text-xl text-card-foreground">{registeredDomain}</p>
              <p className="text-sm text-muted-foreground">
                Your domain is registered. We'll set up the DNS records automatically.
              </p>
              <Button size="lg" className="w-full" onClick={goNext}>
                Continue <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            </div>
          ) : (
            <>
              <div>
                <Label htmlFor="onb-custom-domain">Search for a domain</Label>
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
              </div>

              {domainResults.length > 0 && (
                <div className="space-y-2">
                  {domainResults.map((result) => {
                    const checked = result.available !== undefined;
                    return (
                      <div
                        key={result.name}
                        className={cn(
                          "flex items-center justify-between rounded-large-element border p-3 gap-3",
                          result.available ? "border-success/30 bg-success/5" : "border-border"
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <span className="font-mono text-sm text-card-foreground">{result.name}</span>
                          {result.price && (
                            <span className="ml-2 text-xs text-muted-foreground">${result.price}/year</span>
                          )}
                        </div>
                        {checked ? (
                          result.available ? (
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
                          ) : (
                            <Badge variant="outline">Taken</Badge>
                          )
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleCheckDomain(result.name)}
                            disabled={checkingDomain === result.name}
                          >
                            {checkingDomain === result.name ? <Loader2 className="w-3 h-3 animate-spin" /> : "Check"}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );



  const renderFreeDomain = () => (
    <div className="flex flex-col items-center text-center py-4">
      <Globe size={48} className="text-muted-foreground mx-auto mb-4" />
      <h1 className="font-mono text-3xl font-normal text-card-foreground tracking-tight mb-3">
        Pick your free domain
      </h1>
      <p className="text-muted-foreground text-sm leading-relaxed max-w-md mb-6">
        Choose a name for your free subdomain. Your apps will live at{" "}
        <span className="font-mono">yourname.free.servers.libreloom.org</span>.
      </p>

      <form
        onSubmit={(e) => { e.preventDefault(); if (subdomainName.trim()) goNext(); }}
        className="w-full max-w-sm space-y-4 text-left"
      >
        <div>
          <Label htmlFor="onb-subdomain">Subdomain name</Label>
          <Input
            id="onb-subdomain"
            type="text"
            value={subdomainName}
            onChange={(e) => setSubdomainName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            placeholder="your-name"
            autoFocus
          />
          {subdomainName && (
            <p className="mt-2 text-sm font-mono text-foreground bg-muted rounded-large-element px-3 py-2">
              {subdomainName}.free.servers.libreloom.org
            </p>
          )}
        </div>
        <Button type="submit" className="w-full" size="lg" disabled={!subdomainName.trim()}>
          Continue <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </form>
    </div>
  );


  const renderConnectKey = () => (
    <div className="flex flex-col items-center text-center py-4">
      <Key size={48} className="text-muted-foreground mx-auto mb-4" />
      <h1 className="font-mono text-3xl font-normal text-card-foreground tracking-tight mb-3">
        Your Connect key
      </h1>
      <p className="text-muted-foreground text-sm leading-relaxed max-w-md mb-6">
        Almost done! Copy this key and paste it back into the LibreServ setup
        page you came from.
      </p>

      {generatingKey && !connectKey ? (
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Generating your key…</p>
        </div>
      ) : connectKey ? (
        <div className="w-full max-w-sm space-y-6">
          <div className="rounded-large-element bg-muted border border-border p-5">
            <div className="flex items-center gap-3">
              <Key className="w-5 h-5 text-muted-foreground shrink-0" />
              <code className="text-base font-mono flex-1 break-all select-all text-foreground">
                {connectKey}
              </code>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleCopy(connectKey)}
                title="Copy to clipboard"
              >
                {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
          </div>

          <div className="text-left space-y-3">
            <h3 className="font-mono text-sm text-card-foreground">Next steps:</h3>
            <ol className="space-y-2 text-sm text-muted-foreground">
              <li className="flex gap-2">
                <span className="font-mono text-card-foreground">1.</span>
                Copy the key above
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-card-foreground">2.</span>
                Return to the LibreServ setup page on your device
              </li>
              <li className="flex gap-2">
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
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">Something went wrong. Try again.</p>
          <Button size="lg" variant="outline" onClick={handleGenerateKey}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );

  const stepComponents = [renderWelcome, renderAuth, renderPlan, renderDomain, renderConnectKey];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <ProgressBar step={step} />

      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <div
          ref={outerRef}
          className="w-full max-w-xl rounded-large-element border border-border bg-card text-card-foreground shadow-[0_32px_80px_rgba(0,0,0,0.12)] overflow-hidden transition-[height] ease-[cubic-bezier(0.05,0.7,0.1,1)]"
          style={{ transitionDuration: "300ms" }}
        >
          <div ref={innerRef} className="px-10 py-10">
            <ErrorBanner error={error} onDismiss={clearError} />
            <div key={step} className={cn("mt-2", direction === "left" ? "slide-in-from-left-pop" : "slide-in-from-right-pop")} style={{ animationDuration: "300ms", animationFillMode: "both" }}>
              {stepComponents[step]?.()}
            </div>
          </div>
        </div>
      </div>

      {step > 0 && step < 5 && (
        <div className="px-4 pb-6 flex justify-center">
          <Button variant="outline" onClick={handleBack}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        </div>
      )}
    </div>
  );
}
