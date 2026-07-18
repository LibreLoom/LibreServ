import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { Separator } from "../components/ui/separator.jsx";
import {
  Sparkles, User, Server, CreditCard, Globe, Key,
  ChevronRight, ChevronLeft, Copy, Check, Loader2, Search,
  Shield, Zap, Star, ArrowRight, X
} from "lucide-react";

const STEP_LABELS = ["Welcome", "Account", "Device", "Plan", "Domain", "Key"];

function ProgressBar({ step }) {
  return (
    <div className="flex items-center justify-center gap-1 mb-8">
      {STEP_LABELS.map((label, i) => (
        <div key={label} className="flex items-center">
          <div
            className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-mono transition-colors ${
              i < step
                ? "bg-primary text-primary-foreground"
                : i === step
                ? "bg-primary/20 text-primary ring-2 ring-primary"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {i < step ? <Check className="w-4 h-4" /> : i + 1}
          </div>
          {i < STEP_LABELS.length - 1 && (
            <div
              className={`w-6 sm:w-12 h-0.5 mx-0.5 transition-colors ${
                i < step ? "bg-primary" : "bg-muted"
              }`}
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
    <div className="rounded-lg bg-destructive/10 border border-destructive/30 p-3 flex items-start gap-2">
      <X className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
      <p className="text-sm text-destructive flex-1">{error}</p>
      {onDismiss && (
        <button onClick={onDismiss} className="text-destructive/60 hover:text-destructive">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export default function Onboarding() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");

  // Auth fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isLoginMode, setIsLoginMode] = useState(false);

  // Device
  const [deviceName, setDeviceName] = useState("");

  // Plan
  const [selectedPlan, setSelectedPlan] = useState(null);

  // Domain
  const [subdomainName, setSubdomainName] = useState("");
  const [domainMode, setDomainMode] = useState("subdomain"); // "subdomain" | "custom"
  const [customDomainQuery, setCustomDomainQuery] = useState("");
  const [domainResults, setDomainResults] = useState([]);
  const [checkingDomain, setCheckingDomain] = useState(null);
  const [purchasingDomain, setPurchasingDomain] = useState(false);
  const [registeredDomain, setRegisteredDomain] = useState(null);

  // License key
  const [licenseKey, setLicenseKey] = useState(null);
  const [generatingKey, setGeneratingKey] = useState(false);

  const { data: plansData } = useQuery({
    queryKey: ["plans"],
    queryFn: api.getPlans,
    suspense: false,
  });
  const plans = plansData?.plans || [];

  const currentPlan = selectedPlan ? plans.find((p) => p.id === selectedPlan) : null;
  const isFreePlan = currentPlan?.name?.toLowerCase() === "free";

  // ---- Handlers ----

  const clearError = () => setError("");

  const handleAuth = async (e) => {
    e.preventDefault();
    clearError();
    try {
      if (isLoginMode) {
        const res = await login(email, password, totpCode);
        if (res?.requires_2fa) {
          // login call already set token if 2FA is configured; just move on
        }
      } else {
        await api.register(email, password, name);
        const res = await login(email, password);
        if (res?.requires_2fa) {
          // user will need to enter totp on next auth attempt; skip auth for onboarding
        }
      }
      setStep(2);
    } catch (err) {
      setError(err.message || "Could not complete sign-in. Check your details.");
    }
  };

  const handleGenerateKey = async () => {
    if (!selectedPlan) return;
    setGeneratingKey(true);
    clearError();
    try {
      const res = await api.generateLicenseKey(selectedPlan);
      setLicenseKey(res.key);
    } catch (err) {
      setError(err.message || "Could not generate a license key. Try again.");
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
      setError(err.message || "Could not find matching domains.");
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
      setError(err.message || "Could not check domain availability.");
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

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  // ---- Navigation ----

  const goNext = () => setStep((s) => s + 1);
  const goPrev = () => setStep((s) => s - 1);
  const goBack = () => navigate("/");

  const handleBack = step === 0 ? goBack : goPrev;

  const canProceed = () => {
    switch (step) {
      case 0:
        return true;
      case 1:
        return email && password && (isLoginMode || name);
      case 2:
        return deviceName.trim().length > 0;
      case 3:
        return selectedPlan !== null;
      case 4:
        if (isFreePlan) return subdomainName.trim().length > 0;
        return domainMode === "subdomain"
          ? subdomainName.trim().length > 0
          : registeredDomain !== null;
      case 5:
        return licenseKey !== null;
      default:
        return true;
    }
  };

  // ---- Step renderers ----

  const renderWelcome = () => (
    <div className="text-center space-y-6 animate-fade-in">
      <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
        <Sparkles className="w-8 h-8 text-primary" />
      </div>
      <h1 className="font-mono text-3xl sm:text-4xl">
        Let's set up your LibreServ Connect account
      </h1>
      <p className="text-muted-foreground max-w-md mx-auto">
        It only takes a few minutes. We'll walk you through creating your account, picking a plan,
        and getting a license key for your device.
      </p>
      <Button
        className="mt-4 text-lg px-8"
        size="lg"
        onClick={goNext}
      >
        Get started <ArrowRight className="w-5 h-5 ml-1" />
      </Button>
    </div>
  );

  const renderAuth = () => (
    <div className="space-y-6 animate-fade-in">
      <div className="text-center space-y-2">
        <h2 className="font-mono text-2xl">
          {isLoginMode ? "Welcome back" : "Create your account"}
        </h2>
        <p className="text-muted-foreground">
          {isLoginMode
            ? "Sign in to your LibreServ Connect account"
            : "Create a LibreServ Connect account to get started"}
        </p>
      </div>

      <form onSubmit={handleAuth} className="space-y-4">
        {!isLoginMode && (
          <div>
            <Label htmlFor="onb-name">Name</Label>
            <Input
              id="onb-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>
        )}
        <div>
          <Label htmlFor="onb-email">Email</Label>
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
              Use at least 8 characters. Mix letters, numbers, and symbols for a strong password.
            </p>
          )}
        </div>
        {isLoginMode && totpCode && (
          <div>
            <Label htmlFor="onb-totp">2FA code (if enabled)</Label>
            <Input
              id="onb-totp"
              type="text"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              placeholder="Enter your TOTP code"
              autoComplete="one-time-code"
            />
          </div>
        )}

        <Button type="submit" className="w-full" size="lg">
          {isLoginMode ? "Sign in" : "Create account and sign in"}
        </Button>
      </form>

      <div className="text-center">
        <button
          type="button"
          onClick={() => {
            setIsLoginMode(!isLoginMode);
            setError("");
            setTotpCode("");
          }}
          className="text-sm text-muted-foreground hover:text-foreground underline"
        >
          {isLoginMode ? "Don't have an account? Register" : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );

  const renderDevice = () => (
    <div className="space-y-6 animate-fade-in">
      <div className="text-center space-y-2">
        <h2 className="font-mono text-2xl">Name your device</h2>
        <p className="text-muted-foreground">
          Give your LibreServ device a name. You'll paste a token from this page into your device
          later to link them together.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (deviceName.trim()) goNext();
        }}
        className="space-y-4"
      >
        <div>
          <Label htmlFor="onb-device">Device name</Label>
          <Input
            id="onb-device"
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="e.g., Bedroom Laptop"
            autoFocus
          />
        </div>
        <Button type="submit" className="w-full" size="lg" disabled={!deviceName.trim()}>
          Continue <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </form>
    </div>
  );

  const renderPlan = () => (
    <div className="space-y-6 animate-fade-in">
      <div className="text-center space-y-2">
        <h2 className="font-mono text-2xl">Choose a plan</h2>
        <p className="text-muted-foreground">
          Pick the plan that fits your needs. You can change it later.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = selectedPlan === plan.id;
          const limits = plan.limits || {};
          const price = plan.price_monthly / 100;

          return (
            <Card
              key={plan.id}
              className={`cursor-pointer transition-all hover:scale-[1.02] ${
                isCurrent ? "ring-2 ring-primary" : ""
              }`}
              onClick={() => setSelectedPlan(plan.id)}
            >
              <CardHeader>
                <CardTitle>{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="font-mono text-3xl">
                  ${price}
                  <span className="text-sm text-muted-foreground font-sans">/month</span>
                </p>
                <ul className="space-y-1.5 text-sm text-muted-foreground">
                  {limits.backup_gb !== undefined && (
                    <li>Backup: {limits.backup_gb} GB</li>
                  )}
                  {(limits.ai_credit_cents || 0) > 0 && (
                    <li>AI credit: ${(limits.ai_credit_cents / 100).toFixed(2)}/month</li>
                  )}
                  {limits.tunnel_gb !== undefined && (
                    <li>Tunnel: {limits.tunnel_gb} GB</li>
                  )}
                  {limits.smtp_monthly !== undefined && (
                    <li>Email: {limits.smtp_monthly}/month</li>
                  )}
                </ul>
              </CardContent>
              <CardContent>
                {isCurrent ? (
                  <div className="flex items-center gap-2 text-primary text-sm font-mono">
                    <Check className="w-4 h-4" /> Selected
                  </div>
                ) : (
                  <Button className="w-full" variant={price > 0 ? "default" : "outline"}>
                    {price > 0 ? `Choose ${plan.name}` : "Choose Free"}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {selectedPlan && !isFreePlan && (
        <div className="rounded-lg bg-muted/50 border border-border p-4">
          <p className="text-sm text-muted-foreground">
            You'll complete payment securely via Polar after setup. We'll walk you through
            the rest of setup first, then you can check out from your dashboard.
          </p>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          size="lg"
          disabled={!selectedPlan}
          onClick={goNext}
        >
          Continue <ChevronRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  );

  const renderDomain = () => {
    if (isFreePlan) {
      return renderFreeDomain();
    }
    return renderPaidDomain();
  };

  const renderFreeDomain = () => (
    <div className="space-y-6 animate-fade-in">
      <div className="text-center space-y-2">
        <h2 className="font-mono text-2xl">Pick your free domain</h2>
        <p className="text-muted-foreground">
          You'll get a free subdomain like <code className="text-sm font-mono bg-muted px-1.5 py-0.5 rounded">yourname.free.servers.libreloom.org</code>.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (subdomainName.trim()) goNext();
        }}
        className="space-y-4"
      >
        <div>
          <Label htmlFor="onb-subdomain">Subdomain name</Label>
          <div className="relative">
            <Input
              id="onb-subdomain"
              type="text"
              value={subdomainName}
              onChange={(e) => setSubdomainName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              placeholder="your-name"
              autoFocus
            />
          </div>
          {subdomainName && (
            <p className="mt-2 text-sm font-mono text-muted-foreground bg-muted p-2 rounded">
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

  const renderPaidDomain = () => (
    <div className="space-y-6 animate-fade-in">
      <div className="text-center space-y-2">
        <h2 className="font-mono text-2xl">Choose your domain</h2>
        <p className="text-muted-foreground">
          Pick a free subdomain or register a custom domain through Cloudflare.
        </p>
      </div>

      {/* Toggle */}
      <div className="flex bg-muted rounded-lg p-1">
        <button
          type="button"
          className={`flex-1 py-2 px-4 rounded-md text-sm font-mono transition-colors ${
            domainMode === "subdomain"
              ? "bg-card text-card-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => {
            setDomainMode("subdomain");
            setDomainResults([]);
            setRegisteredDomain(null);
            setError("");
          }}
        >
          Free subdomain
        </button>
        <button
          type="button"
          className={`flex-1 py-2 px-4 rounded-md text-sm font-mono transition-colors ${
            domainMode === "custom"
              ? "bg-card text-card-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => {
            setDomainMode("custom");
            setSubdomainName("");
            setError("");
          }}
        >
          Custom domain
        </button>
      </div>

      {domainMode === "subdomain" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (subdomainName.trim()) goNext();
          }}
          className="space-y-4"
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
              <p className="mt-2 text-sm font-mono text-muted-foreground bg-muted p-2 rounded">
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
        <div className="space-y-4">
          {registeredDomain ? (
            <div className="text-center space-y-2">
              <div className="mx-auto w-12 h-12 rounded-full bg-green-500/20 flex items-center justify-center">
                <Check className="w-6 h-6 text-green-500" />
              </div>
              <p className="font-mono text-lg text-card-foreground">{registeredDomain}</p>
              <p className="text-sm text-muted-foreground">
                Your custom domain is registered. You'll set up the DNS records after onboarding.
              </p>
              <div className="flex justify-center pt-2">
                <Button size="lg" onClick={goNext}>
                  Continue <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="onb-custom-domain">Search for a domain</Label>
                <div className="flex gap-2">
                  <Input
                    id="onb-custom-domain"
                    type="text"
                    value={customDomainQuery}
                    onChange={(e) => setCustomDomainQuery(e.target.value)}
                    placeholder="my-awesome-site"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSearchDomain();
                    }}
                  />
                  <Button variant="outline" onClick={handleSearchDomain} disabled={!customDomainQuery.trim()}>
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
                        className="flex items-center justify-between rounded-lg border p-3 gap-3"
                      >
                        <div className="flex-1 min-w-0">
                          <span className="font-mono text-sm">
                            {result.name}
                          </span>
                          {result.price && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              ${result.price}/year
                            </span>
                          )}
                        </div>
                        {checked ? (
                          result.available ? (
                            <div className="flex gap-2">
                              <span className="text-xs text-green-500 font-mono">Available</span>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handlePurchaseDomain(result.name)}
                                disabled={purchasingDomain}
                              >
                                {purchasingDomain ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <>Register</>
                                )}
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground font-mono">Taken</span>
                          )
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleCheckDomain(result.name)}
                            disabled={checkingDomain === result.name}
                          >
                            {checkingDomain === result.name ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              "Check"
                            )}
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

  const renderLicenseKey = () => (
    <div className="space-y-6 animate-fade-in">
      <div className="text-center space-y-2">
        <h2 className="font-mono text-2xl">Your license key</h2>
        <p className="text-muted-foreground">
          This key links your LibreServ device to your account. Paste it into your device's
          settings.
        </p>
      </div>

      {!licenseKey ? (
        <div className="text-center space-y-4">
          <Button
            className="text-lg px-8"
            size="lg"
            loading={generatingKey}
            onClick={handleGenerateKey}
          >
            Generate license key
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          <Card className="bg-muted/50">
            <CardContent className="pt-6 pb-6">
              <div className="flex items-center gap-3">
                <Key className="w-5 h-5 text-primary shrink-0" />
                <code className="text-lg font-mono flex-1 break-all select-all">
                  {licenseKey}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => copyToClipboard(licenseKey)}
                  title="Copy to clipboard"
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-3">
            <h3 className="font-mono text-sm">How to use this key:</h3>
            <ol className="space-y-2 text-sm text-muted-foreground">
              <li className="flex gap-2">
                <span className="font-mono text-primary">1.</span>
                Open your LibreServ device
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-primary">2.</span>
                Go to Settings → Connect
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-primary">3.</span>
                Paste the license key above and save
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-primary">4.</span>
                Your device will appear in your dashboard
              </li>
            </ol>
          </div>

          <div className="flex justify-center pt-2">
            <Button size="lg" onClick={() => navigate("/")}>
              Done — take me to my dashboard <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  const stepComponents = [renderWelcome, renderAuth, renderDevice, renderPlan, renderDomain, renderLicenseKey];

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <ProgressBar step={step} />

      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <Card className="w-full max-w-2xl animate-fade-in">
          <CardContent className="pt-8">
            <ErrorBanner error={error} onDismiss={clearError} />
            <div className="mt-4">
              {stepComponents[step]?.()}
            </div>
          </CardContent>
        </Card>
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
