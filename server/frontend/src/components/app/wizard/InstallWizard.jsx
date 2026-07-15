import { memo, useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../../hooks/useAuth";
import { useInvalidateApps } from "../../../hooks/useApps";
import WizardStepper from "./WizardStepper";
import OverviewStep from "./OverviewStep";
import ConfigureStep from "./ConfigureStep";
import SubdomainStep from "./SubdomainStep";
import NoDomainWarningStep from "./NoDomainWarningStep";
import ProgressStep from "./ProgressStep";
import CompleteStep from "./CompleteStep";

/**
 * @param {{ appId: any, initialInstanceId?: string }} _
 */
function InstallWizard({ appId, initialInstanceId }) {
  const navigate = useNavigate();
  const { request } = useAuth();
  const invalidateApps = useInvalidateApps();

  const [step, setStep] = useState(1);
  const [app, setApp] = useState(null);
  const [features, setFeatures] = useState(null);
  const [config, setConfig] = useState(/** @type {Record<string, any>} */ ({}));
  const [instance, setInstance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [alreadyInstalled, setAlreadyInstalled] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [animationDirection, setAnimationDirection] = useState("initial");
  const prevStepRef = useRef(1);
  const [subdomain, setSubdomain] = useState("");
  const [domain, setDomain] = useState("");
  const [domainConfigured, setDomainConfigured] = useState(false);

  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(() => setShowWizard(true), 50);
      return () => clearTimeout(timer);
    }
  }, [loading]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [appRes, featuresRes, installedRes, settingsRes] = await Promise.all([
          request(`/catalog/${appId}`),
          request(`/catalog/${appId}/features`),
          request("/apps"),
          request("/settings/proxy"),
        ]);

        const appData = await appRes.json();
        const featuresData = await featuresRes.json();
        const installedData = await installedRes.json();

        const isInstalled = installedData.apps?.some(
          (installed) => installed.app_id === appId
        );

        if (isInstalled) {
          setAlreadyInstalled(true);
          setLoading(false);
          return;
        }

        setApp(appData);
        setFeatures(featuresData);

        // If an initial instance ID was provided (e.g., user returned mid-install),
        // restore the installation state and jump to the appropriate step.
        if (initialInstanceId) {
          try {
            const instanceRes = await request(`/apps/${initialInstanceId}`);
            if (instanceRes.ok) {
              const instanceData = await instanceRes.json();
              setInstance(instanceData);
              setLoading(false);
              if (instanceData.status === "running") {
                setStep(completeStep);
              } else if (instanceData.status === "installing") {
                setStep(progressStep);
              }
              return;
            }
          } catch (err) {
            console.error("Failed to resume installation:", err);
            // Fall through to normal wizard startup.
          }
        }

        const defaultConfig = {};
        if (appData.configuration) {
          appData.configuration.forEach((field) => {
            if (field.default !== undefined) {
              defaultConfig[field.name] = field.default;
            }
          });
        }
        setConfig(defaultConfig);

        // Check if domain is configured
        const settings = await settingsRes.json();
        const configuredDomain = settings?.proxy?.default_domain;
        setDomain(configuredDomain);
        // Treat localhost/empty as "not configured"
        const isDomainActuallyConfigured = configuredDomain && configuredDomain !== "localhost" && configuredDomain !== "127.0.0.1";
        setDomainConfigured(isDomainActuallyConfigured);

        // Auto-fill subdomain if domain is configured
        if (configuredDomain) {
          const suggested = appData.name
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/^-+|-+$/g, "")
            .replace(/-+/g, "-")
            .substring(0, 50);
          setSubdomain(suggested);
        }

        setLoading(false);
      } catch (err) {
        console.error("Failed to load app data:", err);
        setError("Failed to load application details. Please try again.");
        setLoading(false);
      }
    };

    if (appId) {
      fetchData();
    }
  }, [appId, request, initialInstanceId]);

  const handleStepChange = useCallback((newStep) => {
    const direction = newStep > prevStepRef.current ? "right" : "left";
    setAnimationDirection(direction);
    prevStepRef.current = newStep;
    setStep(newStep);
  }, []);

  // Calculate step numbers based on whether domain is configured
  const hasSubdomainStep = domainConfigured;
  const progressStep = 4;
  const completeStep = 5;

  const handleInstall = useCallback(async () => {
    handleStepChange(progressStep);

    try {
      const installConfig = { ...config };

      if (features?.access_model === "shared_account" && installConfig._shared_username) {
        installConfig.admin_username = installConfig._shared_username;
        delete installConfig._shared_username;
      }
      if (features?.access_model === "shared_account" && installConfig._shared_password) {
        installConfig.admin_password = installConfig._shared_password;
        delete installConfig._shared_password;
      }

      const installRequest = {
        app_id: appId,
        name: app?.name,
        config: installConfig,
      };

      // Add domain config if available
      if (domainConfigured && domain && subdomain) {
        installRequest.domain_config = {
          subdomain: subdomain,
          domain: domain,
        };
      }

      const res = await request("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(installRequest),
      });

      const data = await res.json();
      setInstance(data.app);
    } catch (err) {
      console.error("Install failed:", err);
      setError("Installation failed. Please check your settings and try again.");
      // Go back to appropriate step based on domain configuration
      const errorStep = hasSubdomainStep ? 3 : 3; // Always go back to step 3 (warning or subdomain)
      handleStepChange(errorStep);
    }
  }, [appId, config, features, request, handleStepChange, domainConfigured, domain, subdomain, app, progressStep, hasSubdomainStep]);

  const handleComplete = useCallback(
    (statusData) => {
      setInstance((prev) => ({
        ...prev,
        status: statusData.status,
      }));
      setStep(completeStep);
    },
    [completeStep]
  );

  const handleDone = useCallback(() => {
    invalidateApps();
    navigate("/apps");
  }, [navigate, invalidateApps]);

  const handleBack = useCallback(() => {
    navigate("/apps");
  }, [navigate]);

  if (loading) {
    return null;
  }

  if (alreadyInstalled) {
    return (
      <div className="text-center space-y-6 py-8">
        <h2 className="font-mono text-2xl font-normal text-secondary">
          Already Installed
        </h2>
        <p className="text-secondary/70">
          {app?.name || appId} is already installed on your device.
        </p>
        <button
          onClick={() => navigate("/apps")}
          className="px-6 py-2 rounded-pill bg-secondary text-primary hover:bg-secondary/90 motion-safe:transition-all font-mono"
        >
          Back to Apps
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center space-y-6 py-8">
        <h2 className="font-mono text-2xl font-normal text-secondary">
          Something went wrong
        </h2>
        <p className="text-secondary/70">{error}</p>
        <button
          onClick={() => navigate("/apps")}
          className="px-6 py-2 rounded-pill bg-secondary text-primary hover:bg-secondary/90 motion-safe:transition-all font-mono"
        >
          Back to Apps
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className={`transition-all duration-300 delay-75 ${showWizard ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}`}>
        <WizardStepper currentStep={step} hasSubdomainStep={hasSubdomainStep} />
      </div>

      <div className="max-w-2xl mx-auto">
        {step === 1 && (
          <div
            key={`step-1-${animationDirection}`}
            className={`animate-in duration-300 ${animationDirection === "initial" ? "slide-in-from-bottom-4" : animationDirection === "right" ? "slide-in-from-right-pop" : "slide-in-from-left-pop"}`}
          >
            <OverviewStep
              app={app}
              features={features}
              onContinue={() => handleStepChange(2)}
              onBack={handleBack}
            />
          </div>
        )}

        {step === 2 && (
          <div
            key={`step-2-${animationDirection}`}
            className={`animate-in duration-300 ${animationDirection === "right" ? "slide-in-from-right-pop" : "slide-in-from-left-pop"}`}
          >
            <ConfigureStep
              app={app}
              config={config}
              onConfigChange={setConfig}
              onContinue={() => handleStepChange(3)}
              onBack={() => handleStepChange(1)}
            />
          </div>
        )}

        {step === 3 && !hasSubdomainStep && (
          <div
            key={`step-3-${animationDirection}`}
            className={`animate-in duration-300 ${animationDirection === "right" ? "slide-in-from-right-pop" : "slide-in-from-left-pop"}`}
          >
            <NoDomainWarningStep
              app={app}
              onBack={() => handleStepChange(2)}
              onContinue={handleInstall}
            />
          </div>
        )}

        {step === 3 && hasSubdomainStep && (
          <div
            key={`step-3-${animationDirection}`}
            className={`animate-in duration-300 ${animationDirection === "right" ? "slide-in-from-right-pop" : "slide-in-from-left-pop"}`}
          >
            <SubdomainStep
              app={app}
              domain={domain}
              onSubdomainChange={setSubdomain}
              onContinue={handleInstall}
              onBack={() => handleStepChange(2)}
              loading={loading}
            />
          </div>
        )}

        {step === progressStep && (
          <div
            key={`step-${progressStep}-${animationDirection}`}
            className={`animate-in duration-300 ${animationDirection === "right" ? "slide-in-from-right-pop" : "slide-in-from-left-pop"}`}
          >
            <ProgressStep
              instanceId={instance?.id}
              onComplete={handleComplete}
              hasDomain={domainConfigured}
            />
          </div>
        )}

        {step === completeStep && (
          <div
            key={`step-${completeStep}-${animationDirection}`}
            className={`animate-in duration-300 ${animationDirection === "right" ? "slide-in-from-right-pop" : "slide-in-from-left-pop"}`}
          >
            <CompleteStep app={app} instance={instance} onDone={handleDone} />
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(InstallWizard);
