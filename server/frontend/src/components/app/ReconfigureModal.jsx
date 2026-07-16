import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader2, Settings, ChevronDown, ChevronUp, Info, AlertTriangle } from "lucide-react";
import ModalCard from "../cards/ModalCard";
import ConfigFieldRenderer from "./wizard/ConfigFieldRenderer";

function AdvancedContent({ show, advancedFields, config, handleFieldChange, errors }) {
  const contentRef = useRef(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (contentRef.current) {
      setHeight(contentRef.current.scrollHeight);
    }
  }, [show, advancedFields]);

  return (
    <div
      className="overflow-hidden motion-safe:transition-[max-height,opacity] motion-safe:duration-300 motion-safe:ease-in-out"
      style={{ maxHeight: show ? `${height}px` : "0px", opacity: show ? 1 : 0 }}
    >
      <div ref={contentRef}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pl-6 border-l-2 border-primary/10">
          {advancedFields.map((field) => (
            <div key={field.name} className={field.type === "boolean" ? "sm:col-span-2" : ""}>
              <ConfigFieldRenderer
                field={field}
                value={config[field.name]}
                onChange={(value) => handleFieldChange(field.name, value)}
                surface="secondary"
              />
              {errors[field.name] && (
                <p className="text-xs text-primary mt-1">{errors[field.name]}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.app - The installed app object (must have id, app_id, name, config)
 * @param {() => void} props.onClose - Called when the modal should close
 * @param {(path: string, options?: object) => Promise<Response>} props.request - Authenticated request function from useAuth
 * @param {(updatedApp: object) => void} props.onSuccess - Called with the updated app data after successful reconfigure
 */
export default function ReconfigureModal({ app, onClose, request, onSuccess }) {
  const [catalogApp, setCatalogApp] = useState(null);
  const [loadingFields, setLoadingFields] = useState(true);
  const [config, setConfig] = useState({});
  const [errors, setErrors] = useState({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // Fetch the catalog app definition to get Configuration field schemas.
  useEffect(() => {
    if (!app?.app_id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await request(`/catalog/${app.app_id}`);
        if (!res.ok) throw new Error("Failed to load app settings");
        const data = await res.json();
        if (cancelled) return;
        setCatalogApp(data);
        // Pre-fill config with current values from the installed app.
        setConfig({ ...(app.config || {}) });
      } catch {
        if (!cancelled) setSubmitError("We couldn't load this app's settings. Please try again.");
      } finally {
        if (!cancelled) setLoadingFields(false);
      }
    })();
    return () => { cancelled = true; };
  }, [app?.app_id, app?.config, request]);

  const configuration = useMemo(() => catalogApp?.configuration || [], [catalogApp]);

  const { basicFields, advancedFields } = useMemo(() => {
    const basic = [];
    const advanced = [];
    configuration.forEach((field) => {
      if (field.advanced) advanced.push(field);
      else basic.push(field);
    });
    return { basicFields: basic, advancedFields: advanced };
  }, [configuration]);

  const handleFieldChange = useCallback(
    (fieldName, value) => {
      setConfig((prev) => ({ ...prev, [fieldName]: value }));
      setErrors((prev) => {
        if (!prev[fieldName]) return prev;
        const next = { ...prev };
        delete next[fieldName];
        return next;
      });
    },
    [],
  );

  const validate = useCallback(() => {
    const newErrors = {};
    configuration.forEach((field) => {
      if (field.required) {
        const value = config[field.name];
        if (value === undefined || value === null || value === "") {
          // Password fields are optional to re-enter — existing value is kept.
          if (field.type !== "password") {
            newErrors[field.name] = `${field.label} is required`;
          }
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitError(null);
    if (!validate()) return;

    setSubmitting(true);
    try {
      const res = await request(`/apps/${app.id}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || data.message || "We couldn't update this app's settings.");
      }

      const updatedApp = await res.json();
      onSuccess(updatedApp);
    } catch (err) {
      setSubmitError(err.message || "We couldn't update this app's settings. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const hasFields = configuration.length > 0;

  return (
    <ModalCard
      title="Settings"
      onClose={onClose}
      size="lg"
      data-slot="reconfigure-modal"
      footer={
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={() => onClose()}
            disabled={submitting}
            className="flex-1 px-4 py-2 rounded-pill border-2 border-primary/30 text-primary hover:bg-primary/5 transition-colors disabled:opacity-50 font-mono"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="reconfigure-form"
            disabled={submitting || loadingFields || !hasFields}
            className="flex-1 px-4 py-2 rounded-pill bg-secondary text-primary hover:bg-secondary/90 motion-safe:transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-mono"
          >
            {submitting ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Applying...
              </>
            ) : (
              "Apply & Restart"
            )}
          </button>
        </div>
      }
    >
      <form id="reconfigure-form" onSubmit={handleSubmit} className="space-y-4">
        {/* Intro text — plain language per AGENTS.md conventions */}
        <div className="flex items-start gap-3 p-3 bg-accent/10 rounded-large-element border border-accent/30">
          <Settings className="text-primary/80 shrink-0 mt-0.5" size={18} />
          <div className="text-sm text-primary/80">
            <p>Change the settings for <strong>{app?.name}</strong>.</p>
            <p className="mt-1 text-primary/60">
              The app will restart to apply your changes. Passwords that you leave blank will keep their current values.
            </p>
          </div>
        </div>

        {loadingFields && (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={24} className="animate-spin text-primary/50" />
          </div>
        )}

        {submitError && (
          <div className="flex items-center gap-3 p-3 bg-error/10 rounded-large-element border border-error/30">
            <AlertTriangle className="text-error shrink-0" size={18} />
            <p className="text-sm text-error">{submitError}</p>
          </div>
        )}

        {!loadingFields && hasFields && (
          <>
            {basicFields.length > 0 && (
              <div className="space-y-4">
                <p className="text-xs font-mono text-primary/50 uppercase tracking-wide">
                  Application Settings
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {basicFields.map((field) => (
                    <div
                      key={field.name}
                      className={field.type === "boolean" ? "sm:col-span-2" : ""}
                    >
                      <ConfigFieldRenderer
                        field={field}
                        value={config[field.name]}
                        onChange={(value) => handleFieldChange(field.name, value)}
                        disabled={submitting}
                        surface="secondary"
                      />
                      {errors[field.name] && (
                        <p className="text-xs text-primary mt-1">{errors[field.name]}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {advancedFields.length > 0 && (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-2 text-xs font-mono text-primary/50 uppercase tracking-wide hover:text-primary/70 motion-safe:transition-colors"
                >
                  {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  Advanced Settings
                </button>
                <AdvancedContent
                  show={showAdvanced}
                  advancedFields={advancedFields}
                  config={config}
                  handleFieldChange={handleFieldChange}
                  errors={errors}
                />
              </div>
            )}
          </>
        )}

        {!loadingFields && !hasFields && (
          <div className="text-center py-8">
            <Info className="mx-auto text-primary/50 mb-3" size={32} />
            <p className="text-primary/70">No settings available to change.</p>
            <p className="text-sm text-primary/60 mt-1">
              This app doesn't have configurable options.
            </p>
          </div>
        )}
      </form>
    </ModalCard>
  );
}
