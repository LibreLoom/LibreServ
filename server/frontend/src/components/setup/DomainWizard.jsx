import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import PropTypes from "prop-types";
import SetupWizard from "../ui/SetupWizard";
import { WIZ } from "./wiz-constants";
import HasDomainStep     from "./steps/HasDomainStep";
import ProviderPickStep  from "./steps/ProviderPickStep";
import CFNSGuideStep     from "./steps/CFNSGuideStep";
import DomainInputStep   from "./steps/DomainInputStep";
import TokenInputStep   from "./steps/TokenInputStep";
import ConnectingStep   from "./steps/ConnectingStep";
import ConnectedStep    from "./steps/ConnectedStep";
import SkipConfirmStep  from "./steps/SkipConfirmStep";
import RegistrarPickStep from "./steps/RegistrarPickStep";
import SearchDomainStep  from "./steps/SearchDomainStep";

function restoreBool(val) {
  if (val === true || val === false) return val;
  return null;
}

function restoreString(val) {
  return typeof val === "string" ? val : "";
}

export default function DomainWizard({ onComplete, onSkip, onDismiss, initialSubStep, initialStepData, saveProgress }) {
  const initData = initialStepData || {};

  const [wizStep,       setWizStep]       = useState(initialSubStep || WIZ.HAS_DOMAIN);
  const [hasDomain,     setHasDomain]     = useState(restoreBool(initData.has_domain));
  const [provider,      setProvider]      = useState(restoreString(initData.provider) || null);
  const [registrar,     setRegistrar]     = useState(restoreString(initData.registrar) || null);
  const [domain,        setDomain]        = useState(restoreString(initData.domain_name));
  const [token,         setToken]         = useState("");
  const [email,         setEmail]         = useState("");
  const [testError,     setTestError]     = useState(null);
  const [testLoading,   setTestLoading]    = useState(false);
  const [connectStatus, setConnectStatus] = useState(null);
  const [applyError,    setApplyError]     = useState(null);
  const [publicIP,      setPublicIP]      = useState(null);
  const [cfNSConfirmed, setCfNSConfirmed]  = useState(!!initData.cf_ns_confirmed);
  const pollRef = useRef(null);
  const savingRef = useRef({});

  const apiProvider = provider === "cf_ns" ? "cloudflare" : (provider ?? "");

  const dismiss = useCallback(() => onDismiss?.(), [onDismiss]);

  const persistProgress = useCallback((subStep, extra) => {
    if (!saveProgress) return;
    const data = {
      ...(savingRef.current),
      ...extra,
    };
    savingRef.current = data;
    saveProgress("domain", subStep, data);
  }, [saveProgress]);

  const providerSteps = useMemo(() => {
    if (provider === "cf_ns") {
      return [
        { id: WIZ.CF_NS_GUIDE,   label: "CF Setup" },
        { id: WIZ.DOMAIN_INPUT, label: "Domain" },
        { id: WIZ.TOKEN_INPUT,  label: "Token" },
        { id: WIZ.CONNECTING,   label: "Connect" },
        { id: WIZ.CONNECTED,    label: "Done" },
      ];
    }
    if (provider === "cloudflare") {
      return [
        { id: WIZ.DOMAIN_INPUT, label: "Domain" },
        { id: WIZ.TOKEN_INPUT,  label: "Token" },
        { id: WIZ.CONNECTING,   label: "Connect" },
        { id: WIZ.CONNECTED,    label: "Done" },
      ];
    }
    return null;
  }, [provider]);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch("/api/v1/setup/dns/status");
        const data = await res.json();
        if (
          data.certificate === "done" ||
          data.certificate === "failed" ||
          data.cert_available === false
        ) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setConnectStatus(data);
          setWizStep(WIZ.CONNECTED);
          persistProgress(WIZ.CONNECTED, { domain_completed: true });
        }
      } catch { /* keep polling */ }
    }, 3000);
  }, [persistProgress]);

  const startApply = useCallback(async () => {
    setApplyError(null);
    try {
      const res  = await fetch("/api/v1/setup/dns/apply", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ provider: apiProvider, domain, api_token: token, email }),
      });
      const data = await res.json();
      setPublicIP(data.public_ip ?? null);
      if (res.ok) {
        startPolling();
      } else {
        setApplyError(data.error ?? "Setup failed.");
      }
    } catch {
      setApplyError("Could not reach the server. Try again.");
    }
  }, [apiProvider, domain, token, email, startPolling]);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    if (wizStep === WIZ.DOMAIN_INPUT && !publicIP) {
      fetch("/api/v1/setup/dns/status")
        .then((r) => r.ok ? r.json() : null)
        .then((d) => { if (d?.public_ip) setPublicIP(d.public_ip); })
        .catch(() => {});
    }
  }, [wizStep, publicIP]);

  const handleHasDomainYes = useCallback(() => {
    setHasDomain(true);
    setTestError(null);
    setCfNSConfirmed(false);
    setWizStep(WIZ.PROVIDER_PICK);
    persistProgress(WIZ.PROVIDER_PICK, { has_domain: true });
  }, [persistProgress]);

  const handleHasDomainBuy = useCallback(() => {
    setHasDomain(false);
    setTestError(null);
    setCfNSConfirmed(false);
    setWizStep(WIZ.REGISTRAR_PICK);
    persistProgress(WIZ.REGISTRAR_PICK, { has_domain: false });
  }, [persistProgress]);

  const handleRegistrarSelect = (id) => {
    if (id === "porkbun") return;
    setRegistrar(id);
    setWizStep(WIZ.SEARCH_DOMAIN);
    persistProgress(WIZ.SEARCH_DOMAIN, { registrar: id });
  };

  const handleBoughtDomain = useCallback(() => {
    setDomain("");
    setToken("");
    setEmail("");
    if (registrar === "cloudflare_reg") {
      setProvider("cloudflare");
    }
    setWizStep(WIZ.PROVIDER_PICK);
    persistProgress(WIZ.PROVIDER_PICK, { registrar });
  }, [registrar, persistProgress]);

  const handleProviderSelect = (p) => {
    setTestError(null);
    if (p !== "cf_ns" && p !== "cloudflare") {
      setTestError("Coming soon \u2014 we\u2019ll add support for this provider shortly.");
      return;
    }
    setProvider(p);
    const nextStep = p === "cf_ns" ? WIZ.CF_NS_GUIDE : WIZ.DOMAIN_INPUT;
    setWizStep(nextStep);
    persistProgress(nextStep, { provider: p });
  };

  const handleCFNSConfirm = () => {
    setWizStep(WIZ.DOMAIN_INPUT);
    persistProgress(WIZ.DOMAIN_INPUT, { cf_ns_confirmed: true });
  };

  const handleDomainNext = () => {
    if (!domain.trim()) return;
    setWizStep(WIZ.TOKEN_INPUT);
    setEmail(`admin@${domain}`);
    persistProgress(WIZ.TOKEN_INPUT, { domain_name: domain });
  };

  const handleTestConnection = async () => {
    if (!token.trim() || !email.trim()) return;
    setTestError(null);
    setTestLoading(true);
    try {
      const res  = await fetch("/api/v1/setup/dns/test", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ provider: apiProvider, domain, api_token: token, email }),
      });
      const data = await res.json();
      if (data.valid) {
        setWizStep(WIZ.CONNECTING);
        persistProgress(WIZ.CONNECTING);
        startApply();
      } else {
        setTestError(data.error ?? "Connection failed \u2014 check your token and domain.");
      }
    } catch {
      setTestError("Could not reach the server. Try again.");
    } finally {
      setTestLoading(false);
    }
  };

  const handleRetry = () => {
    setApplyError(null);
    setWizStep(WIZ.CONNECTING);
    persistProgress(WIZ.CONNECTING);
    startApply();
  };

  const handleConnectWithoutHTTPS = () => {
    setConnectStatus({ certificate: "skipped" });
    setWizStep(WIZ.CONNECTED);
    persistProgress(WIZ.CONNECTED, { domain_completed: true });
  };

  const handleBack = () => {
    let prev;
    switch (wizStep) {
      case WIZ.REGISTRAR_PICK:  prev = WIZ.HAS_DOMAIN; break;
      case WIZ.SEARCH_DOMAIN:   prev = WIZ.REGISTRAR_PICK; break;
      case WIZ.PROVIDER_PICK:   prev = hasDomain ? WIZ.HAS_DOMAIN : WIZ.REGISTRAR_PICK; break;
      case WIZ.CF_NS_GUIDE:     prev = WIZ.PROVIDER_PICK; break;
      case WIZ.DOMAIN_INPUT:    prev = provider === "cf_ns" ? WIZ.CF_NS_GUIDE : WIZ.PROVIDER_PICK; break;
      case WIZ.TOKEN_INPUT:     prev = WIZ.DOMAIN_INPUT; break;
      default: return;
    }
    setWizStep(prev);
    persistProgress(prev);
  };

  const handleNext = () => {
    switch (wizStep) {
      case WIZ.CF_NS_GUIDE:
        if (cfNSConfirmed) handleCFNSConfirm();
        break;
      case WIZ.DOMAIN_INPUT: handleDomainNext();    break;
      case WIZ.TOKEN_INPUT:  handleTestConnection(); break;
      case WIZ.CONNECTED:    onComplete();          break;
      default: break;
    }
  };

  const isLoading = (wizStep === WIZ.TOKEN_INPUT && testLoading) || wizStep === WIZ.CONNECTING;
  const showNext  = ![WIZ.HAS_DOMAIN, WIZ.SKIP_CONFIRM, WIZ.CONNECTING, WIZ.REGISTRAR_PICK, WIZ.SEARCH_DOMAIN, WIZ.PROVIDER_PICK].includes(wizStep);
  const showBack  = [WIZ.REGISTRAR_PICK, WIZ.SEARCH_DOMAIN, WIZ.PROVIDER_PICK, WIZ.CF_NS_GUIDE, WIZ.DOMAIN_INPUT, WIZ.TOKEN_INPUT].includes(wizStep);

  const nextLabel = wizStep === WIZ.TOKEN_INPUT ? "Test Connection" : "Continue";

  const nextDisabled =
    (wizStep === WIZ.DOMAIN_INPUT && !domain.trim()) ||
    (wizStep === WIZ.CF_NS_GUIDE && !cfNSConfirmed);

  return (
    <SetupWizard
      steps={providerSteps}
      currentStepId={wizStep}
      onBack={showBack ? handleBack : undefined}
      onNext={showNext ? handleNext : undefined}
      nextLabel={nextLabel}
      nextDisabled={nextDisabled}
      nextLoading={isLoading}
      showNext={showNext}
      showBack={showBack}
      onClose={dismiss}
    >
      <div key={wizStep} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
      {wizStep === WIZ.HAS_DOMAIN && (
        <HasDomainStep
          onNext={handleHasDomainYes}
          onBuy={handleHasDomainBuy}
        />
      )}
      {wizStep === WIZ.REGISTRAR_PICK && (
        <RegistrarPickStep
          selected={registrar}
          onSelect={handleRegistrarSelect}
        />
      )}
      {wizStep === WIZ.SEARCH_DOMAIN && (
        <SearchDomainStep
          registrar={registrar}
          onContinue={handleBoughtDomain}
          onBack={handleBack}
        />
      )}
      {wizStep === WIZ.PROVIDER_PICK && (
        <ProviderPickStep
          selected={provider}
          onSelect={handleProviderSelect}
        />
      )}
      {wizStep === WIZ.CF_NS_GUIDE && (
        <CFNSGuideStep
          confirmed={cfNSConfirmed}
          onConfirmChange={setCfNSConfirmed}
          onBack={handleBack}
        />
      )}
      {wizStep === WIZ.DOMAIN_INPUT && (
        <DomainInputStep
          domain={domain}
          onDomainChange={setDomain}
          publicIP={publicIP}
          onEnter={handleDomainNext}
          onNext={handleDomainNext}
          onBack={handleBack}
        />
      )}
      {wizStep === WIZ.TOKEN_INPUT && (
        <TokenInputStep
          token={token}
          onTokenChange={setToken}
          email={email}
          onEmailChange={setEmail}
          error={testError}
          loading={testLoading}
          onTest={handleTestConnection}
          onEnter={handleTestConnection}
          onBack={handleBack}
        />
      )}
      {wizStep === WIZ.CONNECTING && (
        <ConnectingStep
          domain={domain}
          connectStatus={connectStatus}
          publicIP={publicIP}
          applyError={applyError}
          onRetry={handleRetry}
          onSkip={handleConnectWithoutHTTPS}
        />
      )}
      {wizStep === WIZ.CONNECTED && (
        <ConnectedStep
          domain={domain}
          provider={provider}
          connectStatus={connectStatus}
          publicIP={publicIP}
        />
      )}
      {wizStep === WIZ.SKIP_CONFIRM && (
        <SkipConfirmStep
          onBack={() => setWizStep(WIZ.HAS_DOMAIN)}
          onSkip={onSkip}
        />
      )}
      </div>
    </SetupWizard>
  );
}

DomainWizard.propTypes = {
  onComplete:      PropTypes.func.isRequired,
  onSkip:          PropTypes.func.isRequired,
  onDismiss:       PropTypes.func,
  initialSubStep:  PropTypes.string,
  initialStepData: PropTypes.object,
  saveProgress:    PropTypes.func,
};
