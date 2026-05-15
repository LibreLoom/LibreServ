import { useState, useCallback, useMemo, useEffect } from "react";
import PropTypes from "prop-types";
import SetupWizard from "../ui/SetupWizard";
import { WIZ, SMTP_PRESETS } from "./smtp-wiz-constants";
import SmtpProviderPickStep from "./steps/SmtpProviderPickStep";
import SmtpCredentialsStep from "./steps/SmtpCredentialsStep";
import SmtpTestingStep from "./steps/SmtpTestingStep";
import SmtpConnectedStep from "./steps/SmtpConnectedStep";
import SmtpSkipConfirmStep from "./steps/SmtpSkipConfirmStep";

function buildInitialConfig(preset) {
  const p = SMTP_PRESETS[preset] || SMTP_PRESETS.custom;
  return {
    host: p.host,
    port: p.port,
    username: preset === "resend" ? "resend" : "",
    password: "",
    from: "",
    use_tls: p.use_tls,
    skip_verify: p.skip_verify,
  };
}

export default function SmtpWizard({ onComplete, onSkip, onDismiss, saveProgress, open = false, existingConfig, initialSubStep, initialStepData }) {
  const initData = initialStepData || {};
  const initPreset = initData.smtp_provider || existingConfig?.preset || null;

  const [wizStep, setWizStep] = useState(
    existingConfig?.configured ? WIZ.CONNECTED
    : initialSubStep || WIZ.PROVIDER_PICK
  );
  const [preset, setPreset] = useState(initPreset);
  const [config, setConfig] = useState(existingConfig?.configured ? {
    host: existingConfig.host || "",
    port: existingConfig.port || 587,
    username: existingConfig.username || "",
    password: "",
    from: existingConfig.from || "",
    use_tls: existingConfig.use_tls ?? true,
    skip_verify: existingConfig.skip_verify ?? false,
  } : initPreset ? buildInitialConfig(initPreset) : buildInitialConfig("custom"));
  const [testError, setTestError] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (preset === "proton" && config.username) {
      setConfig((c) => ({ ...c, from: c.username }));
    }
  }, [preset, config.username]);

  const persistProgress = useCallback((subStep, extra) => {
    if (!saveProgress) return;
    saveProgress("smtp", subStep, extra);
  }, [saveProgress]);

  const providerSteps = useMemo(() => {
    if (!preset) {
      return [{ id: WIZ.PROVIDER_PICK, label: "Provider" }];
    }
    return [
      { id: WIZ.PROVIDER_PICK, label: "Provider" },
      { id: WIZ.CREDENTIALS, label: "Credentials" },
      { id: WIZ.TESTING, label: "Test" },
      { id: WIZ.CONNECTED, label: "Done" },
    ];
  }, [preset]);

  const detectPresetFromHost = useCallback((host) => {
    for (const [id, p] of Object.entries(SMTP_PRESETS)) {
      if (id === "custom") continue;
      if (p.host && host === p.host) return id;
    }
    return "custom";
  }, []);

  const handleProviderSelect = useCallback((p) => {
    setPreset(p);
    setConfig(buildInitialConfig(p));
    setTestError(null);
    setWizStep(WIZ.CREDENTIALS);
    persistProgress(WIZ.CREDENTIALS, { smtp_provider: p });
  }, [persistProgress]);

  const handleTest = useCallback(async () => {
    const fromEmail = preset === "proton" && !config.from ? config.username : config.from;
    if (!config.username || !config.password || !fromEmail) return;
    setTestError(null);
    setTesting(true);
    setWizStep(WIZ.TESTING);
    persistProgress(WIZ.TESTING, { smtp_provider: preset });

    try {
      const csrfRes = await fetch("/api/v1/auth/csrf");
      const csrfData = await csrfRes.json();
      const csrfToken = csrfData.csrf_token;

      const testRes = await fetch("/api/v1/setup/smtp/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({
          to: fromEmail,
          smtp: {
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            from: fromEmail,
            use_tls: config.use_tls,
            skip_verify: config.skip_verify,
          },
        }),
      });

      if (!testRes.ok) {
        const data = await testRes.json();
        const msg = typeof data.error === "string" ? data.error : JSON.stringify(data.error || data.message || "");
        throw new Error(msg || "SMTP test failed");
      }

      const saveRes = await fetch("/api/v1/setup/smtp", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
        },
        credentials: "include",
        body: JSON.stringify({
          smtp: {
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            from: fromEmail,
            use_tls: config.use_tls,
            skip_verify: config.skip_verify,
          },
        }),
      });

      if (!saveRes.ok) {
        const data = await saveRes.json();
        const msg = typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : JSON.stringify(data.error || "");
        throw new Error(msg || "Failed to save SMTP settings");
      }

      setWizStep(WIZ.CONNECTED);
      persistProgress(WIZ.CONNECTED, { smtp_completed: true });
    } catch (err) {
      setTestError(err instanceof Error ? err.message : "Connection failed. Check your credentials.");
    } finally {
      setTesting(false);
    }
  }, [config, preset, persistProgress]);

  const handleRetry = useCallback(() => {
    setTestError(null);
    setWizStep(WIZ.CREDENTIALS);
  }, []);

  const handleBack = useCallback(() => {
    switch (wizStep) {
      case WIZ.CREDENTIALS:
        setWizStep(WIZ.PROVIDER_PICK);
        persistProgress(WIZ.PROVIDER_PICK);
        break;
      case WIZ.TESTING:
        setWizStep(WIZ.CREDENTIALS);
        persistProgress(WIZ.CREDENTIALS);
        break;
      case WIZ.SKIP_CONFIRM:
        setWizStep(WIZ.PROVIDER_PICK);
        persistProgress(WIZ.PROVIDER_PICK);
        break;
      default:
        break;
    }
  }, [wizStep, persistProgress]);

  const handleNext = useCallback(() => {
    switch (wizStep) {
      case WIZ.CREDENTIALS:
        handleTest();
        break;
      case WIZ.CONNECTED:
        onComplete();
        break;
      default:
        break;
    }
  }, [wizStep, handleTest, onComplete]);

  const isLoading = testing;
  const showNext = [WIZ.CREDENTIALS, WIZ.CONNECTED].includes(wizStep);
  const showBack = [WIZ.CREDENTIALS, WIZ.TESTING, WIZ.SKIP_CONFIRM].includes(wizStep);
  const nextLabel = wizStep === WIZ.CREDENTIALS ? "Test & Save" : "Continue";

  const nextDisabled = wizStep === WIZ.CREDENTIALS && (
    !config.host || !config.username || !config.password || (!config.from && preset !== "proton")
  );

  if (!open) return null;

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
      onClose={onDismiss}
    >
      <div key={wizStep} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
        {wizStep === WIZ.PROVIDER_PICK && (
          <SmtpProviderPickStep
            selected={preset}
            onSelect={handleProviderSelect}
          />
        )}
        {wizStep === WIZ.CREDENTIALS && (
          <SmtpCredentialsStep
            preset={preset || "custom"}
            config={config}
            onConfigChange={setConfig}
            error={testError}
            onEnter={handleTest}
          />
        )}
        {wizStep === WIZ.TESTING && (
          <SmtpTestingStep
            error={testError}
            onRetry={handleRetry}
          />
        )}
        {wizStep === WIZ.CONNECTED && (
          <SmtpConnectedStep
            preset={detectPresetFromHost(config.host)}
            host={config.host}
            from={config.from}
          />
        )}
        {wizStep === WIZ.SKIP_CONFIRM && (
          <SmtpSkipConfirmStep
            onBack={() => setWizStep(WIZ.PROVIDER_PICK)}
            onSkip={onSkip}
          />
        )}
      </div>
    </SetupWizard>
  );
}

SmtpWizard.propTypes = {
  onComplete:     PropTypes.func.isRequired,
  onSkip:         PropTypes.func.isRequired,
  onDismiss:      PropTypes.func,
  saveProgress:   PropTypes.func,
  open:           PropTypes.bool,
  existingConfig:  PropTypes.shape({
    configured: PropTypes.bool,
    host:       PropTypes.string,
    port:       PropTypes.number,
    username:   PropTypes.string,
    from:       PropTypes.string,
    use_tls:    PropTypes.bool,
    skip_verify: PropTypes.bool,
    preset:     PropTypes.string,
  }),
  initialSubStep:  PropTypes.string,
  initialStepData: PropTypes.object,
};
