import { useState } from "react";
import ModalCard from "../../cards/ModalCard";
import Button from "../../ui/Button";
import ShakeTarget from "../../ui/ShakeTarget";
import ConfigFieldRenderer from "../wizard/ConfigFieldRenderer";
import { ActionConfirmModal } from "./ActionConfirmModal";
import { ActionResultModal } from "./ActionResultModal";
import { ProgressFeedback } from "../../common/ProgressFeedback";

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

/** @param {{ action: any, onClose: any, onExecute: any, actionLoading?: any }} _ */
export function ActionOptionsModal({ action, onClose, onExecute }) {
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
  const [streamUrl, setStreamUrl] = useState(null);

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
    if (!onExecute) return;
    setExecuting(true);
    setShowConfirm(false);
    try {
      const data = await onExecute(action.name, opts);

      if (!data || data.error) {
        setResult({
          success: false,
          exit_code: data?.code || 0,
          output: "",
          error: data?.error || data?.message || "Unknown error occurred",
          duration: data?.duration || 0,
        });
        return;
      }

      // If stream_url is present, show streaming progress
      if (data.stream_url) {
        setStreamUrl(data.stream_url);
        setExecuting(false);
        return;
      }

      const scriptResult = data.result || data;
      const rawOutput = scriptResult.Output ?? scriptResult.output;
      const duration = data.Duration ?? data.duration ?? scriptResult.Duration ?? scriptResult.duration ?? 0;
      setResult({
        success: scriptResult.Success ?? scriptResult.success ?? true,
        exit_code: scriptResult.ExitCode ?? scriptResult.exit_code ?? 0,
        output: typeof rawOutput === "string"
          ? rawOutput
          : rawOutput == null
            ? ""
            : JSON.stringify(rawOutput),
        error: typeof (scriptResult.Error ?? scriptResult.error) === "string"
          ? (scriptResult.Error ?? scriptResult.error)
          : undefined,
        duration,
      });
    } catch (err) {
      setResult({ success: false, exit_code: 0, output: "", error: err.message || "Failed to execute action", duration: 0 });
    } finally {
      setExecuting(false);
    }
  };

  const handleStreamComplete = ({ exitCode }) => {
    setResult({
      success: exitCode === 0,
      exit_code: exitCode ?? 0,
      output: "Action completed.",
      error: exitCode !== 0 ? "Action failed" : undefined,
      duration: 0,
    });
  };

  const handleStreamError = ({ exitCode, error: streamError }) => {
    setResult({
      success: false,
      exit_code: exitCode ?? 0,
      output: "",
      error: streamError || "Action failed",
      duration: 0,
    });
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

  if (streamUrl && !result) {
    return (
      <ModalCard title={action.label} onClose={handleClose}>
        {({ close }) => (
        <>
        <div className="py-6">
          <ProgressFeedback
            streamUrl={streamUrl}
            title={`Running ${action.label}`}
            onComplete={handleStreamComplete}
            onError={handleStreamError}
          />
        </div>
        <div className="flex gap-3 pt-2">
          <Button
            variant="outline"
            surface="secondary"
            onClick={close}
            fullWidth
          >
            Cancel
          </Button>
        </div>
        </>
        )}
      </ModalCard>
    );
  }

  if (result) {
    return (
      <ActionResultModal
        action={action}
        result={result}
        onClose={() => {
          setResult(null);
          setStreamUrl(null);
          onClose();
        }}
      />
    );
  }

  return (
    <ModalCard title={action.label} onClose={handleClose} data-slot="action-options-modal">
      {({ close }) => (
      <form onSubmit={handleSubmit} className="space-y-4">
        {action.description && (
          <p className="text-sm text-accent mb-4">{action.description}</p>
        )}

        <div className="space-y-4">
          {action.options?.map((option) => {
            const field = scriptOptionToField(option);
            return (
              <ShakeTarget key={option.name} shake={errors[option.name]}>
                <div>
                  <ConfigFieldRenderer
                    field={field}
                    value={options[option.name]}
                    onChange={(val) => handleFieldChange(option.name, val)}
                    disabled={executing}
                  />
                </div>
              </ShakeTarget>
            );
          })}
        </div>

        {Object.keys(errors).length > 0 && (
          <p className="text-sm text-error">Please fill in all required fields</p>
        )}

        <div className="flex gap-3 pt-2">
          <Button
            type="button"
            variant="outline"
            surface="secondary"
            onClick={close}
            disabled={executing}
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={executing}
            loading={executing}
            className="flex-1"
          >
            {executing ? (
              "Running..."
            ) : action.confirm?.enabled ? (
              "Continue"
            ) : (
              "Run"
            )}
          </Button>
        </div>
      </form>
      )}
    </ModalCard>
  );
}
