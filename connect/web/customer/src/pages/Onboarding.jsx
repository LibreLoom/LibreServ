import { useState, useRef, useEffect } from "react";
import PropTypes from "prop-types";
import { useNavigate } from "react-router-dom";

import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent } from "../components/ui/card.jsx";
import { cn } from "../lib/utils.js";
import { useAnimatedHeight } from "../hooks/useAnimatedHeight.js";
import {
  Globe, Key,
  ChevronRight, ChevronLeft, Copy, Check, Loader2,
  ArrowRight, ArrowLeft, Sparkles, User, Server,
  CreditCard, Check as CheckIcon,
  X
} from "lucide-react";
const STEP_LABELS = ["Welcome", "Account", "Device", "Plan", "Domain", "Key"];

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
  const { login } = useAuth();
  const saved = useRef(loadProgress());
  const [step, setStep] = useState(saved.current?.step || 0);
  const [direction, setDirection] = useState("right"); // "right" | "left"
  const [error, setError] = useState("");
  const { outerRef, innerRef } = useAnimatedHeight();

  const [email, setEmail] = useState(saved.current?.email || "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState(saved.current?.name || "");
  const [isLoginMode, setIsLoginMode] = useState(false);

  const [deviceName, setDeviceName] = useState(saved.current?.deviceName || "");

  const [selectedPlan, setSelectedPlan] = useState(saved.current?.selectedPlan || "free");
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(true);



  const [subdomainName, setSubdomainName] = useState(saved.current?.subdomainName || "");
  const [domainMode, setDomainMode] = useState(saved.current?.domainMode || "subdomain");
  const [customDomainQuery, setCustomDomainQuery] = useState("");
  const [domainResults, setDomainResults] = useState([]);
  const [checkingDomain, setCheckingDomain] = useState(null);
  const [purchasingDomain, setPurchasingDomain] = useState(false);
  const [registeredDomain, setRegisteredDomain] = useState(saved.current?.registeredDomain || null);

  const [licenseKey, setLicenseKey] = useState(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  // Persist progress whenever relevant state changes
  useEffect(() => {
    if (step === 0 && !email && !deviceName) return; // don't save empty state
    saveProgress({ step, email, name, deviceName, selectedPlan, subdomainName, domainMode, registeredDomain });
  }, [step, email, name, deviceName, selectedPlan, subdomainName, domainMode, registeredDomain]);

  // Fetch plans on mount
  useEffect(() => {
    api.getPlans()
      .then((res) => setPlans(res.plans || []))
      .catch(() => {})
      .finally(() => setLoadingPlans(false));
  }, []);

  // Auto-generate the license key when the user reaches the key step.
  // The key step is the last step (index 5). We generate once — the guard
  // prevents duplicate calls on re-renders.
  const keyStep = 5; // renderLicenseKey index in stepComponents
  useEffect(() => {
    if (step !== keyStep || licenseKey || generatingKey) return;
    setGeneratingKey(true);
    clearError();
    api.generateLicenseKey()
      .then((res) => setLicenseKey(res.license_key))
      .catch((err) => setError(err.message || "Could not generate your license key. Try again."))
      .finally(() => setGeneratingKey(false));
  }, [step, licenseKey, generatingKey]);

  const clearError = () => setError("");
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
        setError(err.message || "Could not start checkout. Try again or choose Free.");
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
        await api.register(email, password, name);
        await login(email, password);
      }
      setStep(2);
    } catch (err) {
      setError(err.message || "Could not sign in. Check your details and try again.");
    }
  };

  const handleGenerateKey = async () => {
    setGeneratingKey(true);
    clearError();
    try {
      const res = await api.generateLicenseKey();
      setLicenseKey(res.license_key);
    } catch (err) {
      setError(err.message || "Could not generate your license key. Try again.");
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
      await api.registerDomain(deviceName || "", domain);
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

  const renderDevice = () => (
    <div className="flex flex-col items-center text-center py-4">
      <Server size={48} className="text-muted-foreground mx-auto mb-4" />
      <h1 className="font-mono text-3xl font-normal text-card-foreground tracking-tight mb-3">
        Name your device
      </h1>
      <p className="text-muted-foreground text-sm leading-relaxed max-w-md mb-6">
        Give your LibreServ server a name so you can find it in your dashboard later.
      </p>
      <form
        onSubmit={(e) => { e.preventDefault(); if (deviceName.trim()) goNext(); }}
        className="w-full max-w-sm space-y-4 text-left"
      >
        <div>
          <Label htmlFor="onb-device">Device name</Label>
          <Input
            id="onb-device"
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="e.g., Home Server"
            autoFocus
          />
        </div>
        <Button type="submit" className="w-full" size="lg" disabled={!deviceName.trim()}>
          Continue <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </form>
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
        <CreditCard size={48} className="text-muted-foreground mx-auto mb-4" />
        <h1 className="font-mono text-3xl font-normal text-card-foreground tracking-tight mb-3">
          Choose your plan
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed max-w-md mb-6">
          Start free and upgrade anytime. You can change your plan from the dashboard after setup.
        </p>

        <div className="w-full max-w-md space-y-3 text-left">
          {plans.map((p) => {
            const isFree = p.price_monthly === 0;
            const isSelected = selectedPlan === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedPlan(p.id)}
                className={cn(
                  "w-full rounded-large-element border-2 p-4 text-left transition-all motion-safe:duration-200",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40"
                )}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-base">{p.name}</span>
                      {isFree && (
                        <span className="rounded-pill bg-primary/10 px-2 py-0.5 text-xs text-primary">
                          No card needed
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-0.5">{p.description}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-lg">
                      {isFree ? "Free" : `$${(p.price_monthly / 100).toFixed(0)}`}
                    </p>
                    {!isFree && <p className="text-xs text-muted-foreground">per month</p>}
                  </div>
                </div>
                {isSelected && (
                  <div className="mt-2 flex items-center gap-1 text-sm text-primary">
                    <CheckIcon className="w-4 h-4" /> Selected
                  </div>
                )}
              </button>
            );
          })}

          <Button className="w-full" size="lg" loading={checkoutLoading} onClick={handlePlanContinue}>
            {selectedPlan !== "free" && plans.find((p) => p.id === selectedPlan)?.price_monthly > 0
              ? <>Continue to Payment <ChevronRight className="w-4 h-4 ml-1" /></>
              : <>Continue <ChevronRight className="w-4 h-4 ml-1" /></>}
          </Button>
        </div>
      </div>
    );
  };

  const renderDomain = () => renderFreeDomain();



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


  const renderLicenseKey = () => (
    <div className="flex flex-col items-center text-center py-4">
      <Key size={48} className="text-muted-foreground mx-auto mb-4" />
      <h1 className="font-mono text-3xl font-normal text-card-foreground tracking-tight mb-3">
        Your license key
      </h1>
      <p className="text-muted-foreground text-sm leading-relaxed max-w-md mb-6">
        Almost done! Copy this key and paste it back into the LibreServ setup
        page you came from.
      </p>

      {generatingKey && !licenseKey ? (
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Generating your key…</p>
        </div>
      ) : licenseKey ? (
        <div className="w-full max-w-sm space-y-6">
          <div className="rounded-large-element bg-muted border border-border p-5">
            <div className="flex items-center gap-3">
              <Key className="w-5 h-5 text-muted-foreground shrink-0" />
              <code className="text-base font-mono flex-1 break-all select-all text-foreground">
                {licenseKey}
              </code>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleCopy(licenseKey)}
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

  const stepComponents = [renderWelcome, renderAuth, renderDevice, renderPlan, renderDomain, renderLicenseKey];

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

      {step > 0 && step < 6 && (
        <div className="px-4 pb-6 flex justify-center">
          <Button variant="outline" onClick={handleBack}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
        </div>
      )}
    </div>
  );
}
