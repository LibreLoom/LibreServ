import { memo, useState, useCallback, useMemo, useRef, useEffect } from "react";
import ConfigFieldRenderer from "./ConfigFieldRenderer";
import { Info, ChevronDown, ChevronUp } from "lucide-react";

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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pl-6 border-l-2 border-secondary/10">
          {advancedFields.map((field) => (
            <div key={field.name} className={field.type === "boolean" ? "sm:col-span-2" : ""}>
              <ConfigFieldRenderer
                field={field}
                value={config[field.name]}
                onChange={(value) => handleFieldChange(field.name, value)}
                surface="primary"
              />
              {errors[field.name] && (
                <p className="text-xs text-secondary mt-1">{errors[field.name]}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConfigureStep({ app, config, onConfigChange, onContinue, onBack }) {
  const [errors, setErrors] = useState({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  const configuration = useMemo(() => app?.configuration || [], [app?.configuration]);

  const { basicFields, advancedFields } = useMemo(() => {
    const basic = [];
    const advanced = [];
    configuration.forEach((field) => {
      if (field.advanced) {
        advanced.push(field);
      } else {
        basic.push(field);
      }
    });
    return { basicFields: basic, advancedFields: advanced };
  }, [configuration]);

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


  return (
    <form onSubmit={handleSubmit} className="space-y-6" data-slot="configure-step">
      <div className="text-center space-y-2">
        <h2 className="font-mono text-2xl font-normal text-secondary">
          Configure {app?.name || "App"}
        </h2>
        <p className="text-secondary/70 text-sm">
          Set up the basic settings for this application.
        </p>
      </div>


      {basicFields.length > 0 && (
        <div className="space-y-4">
          <p className="text-xs font-mono text-secondary/50 uppercase tracking-wide">
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
                  surface="primary"
                />
                {errors[field.name] && (
                  <p className="text-xs text-secondary mt-1">{errors[field.name]}</p>
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
            className="flex items-center gap-2 text-xs font-mono text-secondary/50 uppercase tracking-wide hover:text-secondary/70 motion-safe:transition-colors"
          >
            <span>
              {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </span>
            Advanced Settings
          </button>

          <AdvancedContent show={showAdvanced} advancedFields={advancedFields} config={config} handleFieldChange={handleFieldChange} errors={errors} />
        </div>
      )}

      {configuration.length === 0 && (
        <div className="text-center py-8">
          <Info className="mx-auto text-secondary/50 mb-3" size={32} />
          <p className="text-secondary/70">No configuration needed.</p>
          <p className="text-sm text-secondary/70 mt-1">
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
