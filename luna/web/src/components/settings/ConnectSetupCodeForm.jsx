import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PropTypes from "prop-types";
import Button from "../ui/Button";
import ShakeTarget from "../components/ui/ShakeTarget";
import { getJson, postJson, apiErrorMessage } from "../../lib/api";

/**
 * Enter or replace the Luna Connect setup code (booklet / site code).
 * Used during first-run setup and in Settings → About → Advanced.
 */
export default function ConnectSetupCodeForm({ surface = "secondary", compact = false }) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const status = useQuery({
    queryKey: ["connect-status"],
    queryFn: () => getJson("/api/v1/connect/status"),
  });

  const saveCode = useMutation({
    mutationFn: () => postJson("/api/v1/connect/setup-code", { code: code.trim() }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connect-status"] });
      setError(null);
      setSaved(true);
      setCode("");
    },
    onError: (err) => {
      setSaved(false);
      setError(apiErrorMessage(err));
    },
  });
  const redeem = useMutation({
    mutationFn: () => postJson("/api/v1/connect/redeem", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connect-status"] });
      setError(null);
      setSaved(true);
    },
    onError: (err) => {
      setSaved(false);
      setError(apiErrorMessage(err));
    },
  });

  const s = status.data || {};
  const enabled = Boolean(s.enabled);
  const inputClass =
    surface === "primary"
      ? "w-full min-w-0 rounded-pill bg-secondary text-primary px-4 py-2 font-mono tracking-widest"
      : "w-full min-w-0 rounded-pill bg-primary text-secondary px-4 py-2 font-mono tracking-widest";

  if (enabled) {
    return (
      <div className="space-y-2" data-slot="connect-setup-code-form">
        <p className="text-sm text-primary leading-relaxed">
          Luna Connect is on
          {s.hostname || s.domain ? (
            <>
              {" "}
              at <span className="font-mono break-all">{s.hostname || s.domain}</span>
            </>
          ) : null}
          . Change the address under External services.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-slot="connect-setup-code-form">
      {!compact && (
        <p className="text-sm text-primary leading-relaxed">
          Paste the setup code from Luna Connect (****-****-****-****-****).
        </p>
      )}
      <div>
        <label htmlFor="luna-connect-setup-code" className="block text-sm text-primary mb-1.5">
          Setup code
        </label>
        <ShakeTarget shake={error}>
          <input
            id="luna-connect-setup-code"
            className={inputClass}
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setSaved(false);
              if (error) setError(null);
            }}
            placeholder="****-****-****-****-****"
            autoComplete="off"
            spellCheck={false}
            aria-label="Setup code from Luna Connect"
            aria-invalid={Boolean(error)}
          />
        </ShakeTarget>
      </div>
      {error && <p className="text-sm text-error leading-relaxed">{error}</p>}
      {saved && !error && (
        <p className="text-sm text-success leading-relaxed">Setup code saved.</p>
      )}
      <div className="flex flex-col gap-2">
        <Button
          variant="primary"
          surface={surface === "primary" ? "primary" : "secondary"}
          fullWidth
          loading={saveCode.isPending}
          disabled={code.replace(/[-_\s]/g, "").length < 16}
          onClick={() => saveCode.mutate()}
        >
          Save setup code
        </Button>
        <Button
          variant="outline"
          surface={surface === "primary" ? "primary" : "secondary"}
          fullWidth
          loading={redeem.isPending}
          onClick={() => redeem.mutate()}
        >
          Use the code that came with this Luna
        </Button>
      </div>
    </div>
  );
}

ConnectSetupCodeForm.propTypes = {
  /** Backdrop the form sits on: page bg (`primary`) or card (`secondary`). */
  surface: PropTypes.oneOf(["primary", "secondary"]),
  compact: PropTypes.bool,
};
