import { memo, useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../../hooks/useAuth";
import WizardStepper from "./WizardStepper";
import OverviewStep from "./OverviewStep";
import ConfigureStep from "./ConfigureStep";
import ProgressStep from "./ProgressStep";
import CompleteStep from "./CompleteStep";

function InstallWizard({ appId }) {
  const navigate = useNavigate();
  const { request } = useAuth();

  const [step, setStep] = useState(1);
  const [app, setApp] = useState(null);
  const [features, setFeatures] = useState(null);
  const [config, setConfig] = useState({});
  const [instance, setInstance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [alreadyInstalled, setAlreadyInstalled] = useState(false);
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    if (!loading) {
      // Small delay to allow DOM to settle, then trigger animations
      const timer = setTimeout(() => setShowWizard(true), 50);
      return () => clearTimeout(timer);
    }
  }, [loading]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [appRes, featuresRes, installedRes] = await Promise.all([
          request(`/catalog/${appId}`),
          request(`/catalog/${appId}/features`),
          request("/apps"),
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

        const defaultConfig = {};
        if (appData.configuration) {
          appData.configuration.forEach((field) => {
            if (field.default !== undefined) {
              defaultConfig[field.name] = field.default;
            }
          });
        }
        setConfig(defaultConfig);
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
  }, [appId, request]);

  const handleInstall = useCallback(async () => {
    setStep(3);

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

      const res = await request("/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: appId,
          config: installConfig,
        }),
      });

      const data = await res.json();
      setInstance(data.app);
    } catch (err) {
      console.error("Install failed:", err);
      setError("Installation failed. Please check your settings and try again.");
      setStep(2);
    }
  }, [appId, config, features, request]);

  const handleComplete = useCallback(
    (statusData) => {
      setInstance((prev) => ({ ...prev, ...statusData }));
      setStep(4);
    },
    []
  );

  const handleError = useCallback((err) => {
    console.error("Installation error:", err);
    setError("Something went wrong during installation.");
  }, []);

  const handleDone = useCallback(() => {
    navigate("/apps");
  }, [navigate]);

  const handleBack = useCallback(() => {
    navigate("/apps");
  }, [navigate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-secondary/50 font-mono">Loading...</p>
      </div>
    );
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
    <div className={`space-y-8 transition-all duration-300 ${showWizard ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}`}>
      <div className={`transition-all duration-300 delay-75 ${showWizard ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}`}>
        <WizardStepper currentStep={step} />
      </div>

      <div className={`max-w-2xl mx-auto transition-all duration-300 delay-150 ${showWizard ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}`}>
        {step === 1 && (
          <OverviewStep
            app={app}
            features={features}
            onContinue={() => setStep(2)}
            onBack={handleBack}
          />
        )}

        {step === 2 && (
          <ConfigureStep
            app={app}
            features={features}
            config={config}
            onConfigChange={setConfig}
            onContinue={handleInstall}
            onBack={() => setStep(1)}
          />
        )}

        {step === 3 && (
          <ProgressStep
            instanceId={instance?.id}
            onComplete={handleComplete}
            onError={handleError}
          />
        )}

        {step === 4 && (
          <CompleteStep app={app} instance={instance} onDone={handleDone} />
        )}
      </div>
    </div>
  );
}

export default memo(InstallWizard);
