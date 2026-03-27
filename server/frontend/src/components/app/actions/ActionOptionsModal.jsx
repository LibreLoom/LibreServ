import { useState } from "react";
import { Loader2 } from "lucide-react";
import ModalCard from "../../common/cards/ModalCard";
import ConfigFieldRenderer from "../wizard/ConfigFieldRenderer";
import { ActionConfirmModal } from "./ActionConfirmModal";
import { ActionResultModal } from "./ActionResultModal";

function scriptOptionToField(option) {
  return {
    name: option.name,
    label: option.label,
    description: option.description,
    type: option.type === "option" ? "select" : option.type,
    default: option.default,
    required: option.required,
    options: option.options || [],
    validation: option.validation,
    min: option.min,
    max: option.max,
    secret: option.secret,
  };
}

export function ActionOptionsModal({ action, instanceId, onClose }) {
  const [options, setOptions] = useState(() => {
    const initial = {};
    action.options?.forEach((opt) => {
      initial[opt.name] = opt.default ?? "";
    });
    return initial;
  });
  const [errors, setErrors] = useState({});
  const [executing, setExecuting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [result, setResult] = useState(null);

  const handleFieldChange = (name, value) => {
    setOptions((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) {
      setErrors((prev) => ({ ...prev, [name]: null }));
    }
  };

  const validate = () => {
    const newErrors = {};
    action.options?.forEach((opt) => {
      if (opt.required && !options[opt.name]) {
        newErrors[opt.name] = `${opt.label} is required`;
      }
    });
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const executeAction = async (opts = options) => {
    setExecuting(true);
    setShowConfirm(false);
    try {
      const response = await fetch(`/api/v1/apps/${instanceId}/actions/${action.name}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action.name, options: opts }),
      });
      const data = await response.json();
      setResult(data.result || { success: response.ok, output: data.error || "Unknown error" });
    } catch (err) {
      setResult({ success: false, error: err.message || "Failed to execute action" });
    } finally {
      setExecuting(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;

    if (action.confirm?.enabled) {
      setShowConfirm(true);
    } else {
      executeAction();
    }
  };

  const handleConfirm = () => {
    executeAction();
  };

  const handleClose = () => {
    if (result) {
      onClose();
      setResult(null);
    } else {
      onClose();
    }
  };

  if (showConfirm) {
    return (
      <ActionConfirmModal
        action={action}
        onConfirm={handleConfirm}
        onCancel={() => setShowConfirm(false)}
        isConfirming={executing}
      />
    );
  }

  if (result) {
    return (
      <ActionResultModal
        action={action}
        result={result}
        onClose={() => {
          setResult(null);
          onClose();
        }}
      />
    );
  }

  return (
    <ModalCard title={action.label} onClose={handleClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {action.description && (
          <p className="text-sm text-primary/70 mb-4">{action.description}</p>
        )}

        <div className="space-y-4">
          {action.options?.map((option) => {
            const field = scriptOptionToField(option);
            return (
              <ConfigFieldRenderer
                key={option.name}
                field={field}
                value={options[option.name]}
                onChange={(val) => handleFieldChange(option.name, val)}
                disabled={executing}
              />
            );
          })}
        </div>

        {Object.keys(errors).length > 0 && (
          <p className="text-sm text-error">Please fill in all required fields</p>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={handleClose}
            disabled={executing}
            className="flex-1 px-4 py-2 rounded-pill border-2 border-primary/30 text-primary hover:bg-primary/5 transition-colors disabled:opacity-50 font-mono"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={executing}
            className="flex-1 px-4 py-2 rounded-pill bg-secondary text-primary hover:bg-secondary/80 motion-safe:transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 font-mono"
          >
            {executing ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Running...
              </>
            ) : action.confirm?.enabled ? (
              "Continue"
            ) : (
              "Run"
            )}
          </button>
        </div>
      </form>
    </ModalCard>
  );
}
