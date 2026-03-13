import { memo, useState, useCallback, useMemo } from "react";
import ConfigFieldRenderer from "./ConfigFieldRenderer";
import { AlertTriangle, Info } from "lucide-react";

function ConfigureStep({ app, features, config, onConfigChange, onContinue, onBack }) {
  const [errors, setErrors] = useState({});

  const configuration = useMemo(() => app?.configuration || [], [app?.configuration]);

  const handleFieldChange = useCallback(
    (fieldName, value) => {
      onConfigChange({ ...config, [fieldName]: value });
      if (errors[fieldName]) {
        setErrors((prev) => {
          const next = { ...prev };
          delete next[fieldName];
          return next;
        });
      }
    },
    [config, onConfigChange, errors],
  );

  const validate = useCallback(() => {
    const newErrors = {};
    configuration.forEach((field) => {
      if (field.required) {
        const value = config[field.name];
        if (value === undefined || value === null || value === "") {
          newErrors[field.name] = `${field.label} is required`;
        }
      }
      if (field.type === "port") {
        const port = parseInt(config[field.name], 10);
        if (config[field.name] && (isNaN(port) || port < 1 || port > 65535)) {
          newErrors[field.name] = "Port must be between 1 and 65535";
        }
      }
    });

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [configuration, config]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (validate()) {
      onContinue();
    }
  };

  const isSharedAccount = features?.access_model === "shared_account";

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="font-mono text-2xl font-normal text-secondary">
          Configure {app?.name || "App"}
        </h2>
        <p className="text-secondary/70 text-sm">
          Set up the basic settings for this application.
        </p>
      </div>

      {isSharedAccount && (
        <div className="p-4 rounded-large-element bg-secondary/10 border border-secondary/30">
          <div className="flex items-start gap-3">
            <AlertTriangle className="text-secondary mt-0.5" size={18} />
            <div className="space-y-3 flex-1">
              <p className="font-mono text-sm text-secondary">
                Shared Credentials
              </p>
              <p className="text-xs text-secondary/70">
                Everyone who uses this app will sign in with these same credentials. Choose something memorable or let us generate secure defaults.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                   <label className="block font-mono text-sm text-secondary">
                     Username
                   </label>
                   <input
                     type="text"
value={config._shared_username || "admin"}
                      onChange={(e) => handleFieldChange("_shared_username", e.target.value)}
                      placeholder="admin"
                      className="w-full px-3 py-2 border-2 border-secondary/30 rounded-large-element bg-primary text-secondary focus-visible:ring-2 focus:ring-accent focus:ring-offset-2"
                   />
                </div>
                <div className="space-y-1">
                   <label className="block font-mono text-sm text-secondary">
                     Password <span className="text-secondary">*</span>
                   </label>
                   <input
                     type="password"
value={config._shared_password || ""}
                      onChange={(e) => handleFieldChange("_shared_password", e.target.value)}
                      placeholder="Leave empty to auto-generate"
                      className="w-full px-3 py-2 border-2 border-secondary/30 rounded-large-element bg-primary text-secondary focus-visible:ring-2 focus:ring-accent focus:ring-offset-2"
                   />
                  <p className="text-xs text-secondary/50">
                    If empty, a secure password will be created for you
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {configuration.length > 0 && (
        <div className="space-y-4">
          <p className="text-xs font-mono text-secondary/50 uppercase tracking-wide">
            Application Settings
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {configuration.map((field) => (
              <div
                key={field.name}
                className={field.type === "boolean" ? "sm:col-span-2" : ""}
              >
                <ConfigFieldRenderer
                  field={field}
                  value={config[field.name]}
                  onChange={(value) => handleFieldChange(field.name, value)}
                />
                {errors[field.name] && (
                  <p className="text-xs text-secondary mt-1">{errors[field.name]}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {configuration.length === 0 && !isSharedAccount && (
        <div className="text-center py-8">
          <Info className="mx-auto text-secondary/50 mb-3" size={32} />
          <p className="text-secondary/70">No configuration needed.</p>
          <p className="text-sm text-secondary/50 mt-1">
            This app is ready to install with default settings.
          </p>
        </div>
      )}

      <div className="flex justify-center gap-3 pt-4">
        <button
          type="button"
          onClick={onBack}
          className="px-6 py-2 rounded-pill border-2 border-secondary/30 text-secondary hover:bg-secondary/10 motion-safe:transition-all font-mono"
        >
          Back
        </button>
        <button
          type="submit"
          className="px-6 py-2 rounded-pill bg-secondary text-primary hover:bg-secondary/90 motion-safe:transition-all font-mono"
        >
          Install
        </button>
      </div>
    </form>
  );
}

export default memo(ConfigureStep);
