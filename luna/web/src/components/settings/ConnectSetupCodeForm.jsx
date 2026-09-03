import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import PropTypes from "prop-types";
import Button from "../ui/Button";
import ShakeTarget from "../ui/ShakeTarget";
import { deleteJson, getJson, postJson, apiErrorMessage } from "../../lib/api";

const LUNA_CONNECT_URL = "https://connect.luna.libreloom.org";

/**
 * Enter or replace the Luna Connect device token.
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
      queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      setError(null);
      setSaved(true);
      setCode("");
    },
    onError: (err) => {
      setSaved(false);
      setError(apiErrorMessage(err));
    },
  });
  const sync = useMutation({
    mutationFn: () => postJson("/api/v1/connect/sync", {}),
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
  const removeToken = useMutation({
    mutationFn: () => deleteJson("/api/v1/connect/device-token"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connect-status"] });
      queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      setError(null);
      setSaved(false);
      setCode("");
    },
    onError: (err) => {
      setError(apiErrorMessage(err));
    },
  });
  const deactivate = useMutation({
    mutationFn: () => postJson("/api/v1/connect/deactivate", {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["connect-status"] });
      queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      setError(null);
      setSaved(false);
    },
    onError: (err) => {
      setError(apiErrorMessage(err));
    },
  });

  const s = status.data || {};
  const connectActive = Boolean(s.connect_active);
  const enabled = Boolean(s.enabled);
  const tokenError =
    typeof s.device_token_error === "string" && s.device_token_error.trim()
      ? s.device_token_error
      : null;
  const linked = enabled && !tokenError;
  const pendingBind = connectActive && !enabled && !tokenError;
  const inputClass =
    surface === "primary"
      ? "w-full min-w-0 rounded-pill bg-secondary text-primary px-4 py-2 font-mono tracking-widest"
      : "w-full min-w-0 rounded-pill bg-primary text-secondary px-4 py-2 font-mono tracking-widest";

  if (linked) {
    return (
      <div className="space-y-3" data-slot="connect-setup-code-form">
        <p className="text-sm text-primary leading-relaxed">
          Luna Connect is on
          {s.hostname || s.domain ? (
            <>
              {" "}
              at <span className="font-mono break-all">{s.hostname || s.domain}</span>
            </>
          ) : null}
          . Configure your subdomain on{" "}
          <a
            href={LUNA_CONNECT_URL}
            className={
              surface === "primary"
                ? "text-accent hover:text-secondary motion-safe:transition-colors underline underline-offset-4"
                : "text-accent hover:text-primary motion-safe:transition-colors underline underline-offset-4"
            }
            target="_blank"
            rel="noopener noreferrer"
          >
            Luna Connect
          </a>
          .
        </p>
        {error && <p className="text-sm text-error leading-relaxed">{error}</p>}
        <div className="flex flex-col gap-2">
          <Button
            variant="danger"
            surface={surface === "primary" ? "primary" : "secondary"}
            fullWidth
            loading={deactivate.isPending}
            onClick={() => deactivate.mutate()}
          >
            Turn Luna Connect off
          </Button>
          <Button
            variant="outline"
            surface={surface === "primary" ? "primary" : "secondary"}
            fullWidth
            loading={removeToken.isPending}
            disabled={deactivate.isPending}
            onClick={() => removeToken.mutate()}
          >
            Remove device token
          </Button>
        </div>
      </div>
    );
  }

  if (pendingBind) {
    return (
      <div className="space-y-3" data-slot="connect-setup-code-form">
        <p className="text-sm text-primary leading-relaxed">
          Luna has a device token but is not linked to Luna Connect yet. Sync to finish setup, or remove the token to turn Connect off.
        </p>
        {error && <p className="text-sm text-error leading-relaxed">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-success leading-relaxed">Synced with Luna Connect.</p>
        )}
        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            surface={surface === "primary" ? "primary" : "secondary"}
            fullWidth
            loading={sync.isPending}
            onClick={() => sync.mutate()}
          >
            Sync with Luna Connect
          </Button>
          <Button
            variant="danger"
            surface={surface === "primary" ? "primary" : "secondary"}
            fullWidth
            loading={removeToken.isPending}
            onClick={() => removeToken.mutate()}
          >
            Remove device token
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-slot="connect-setup-code-form">
      {tokenError && (
        <p className="text-sm text-error leading-relaxed" role="alert">
          {tokenError}
        </p>
      )}
      {!compact && !tokenError && (
        <p className="text-sm text-primary leading-relaxed">
          Paste your device token from Luna Connect (****-****-****-****-****).
        </p>
      )}
      <div>
        <label htmlFor="luna-connect-setup-code" className="block text-sm text-primary mb-1.5">
          Device token
        </label>
        <ShakeTarget shake={error || tokenError}>
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
            aria-label="Device token from Luna Connect"
            aria-invalid={Boolean(error || tokenError)}
          />
        </ShakeTarget>
      </div>
      {error && <p className="text-sm text-error leading-relaxed">{error}</p>}
      {saved && !error && !tokenError && (
        <p className="text-sm text-success leading-relaxed">Device token saved.</p>
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
          Save device token
        </Button>
        {(connectActive || tokenError) && (
          <Button
            variant="outline"
            surface={surface === "primary" ? "primary" : "secondary"}
            fullWidth
            loading={removeToken.isPending}
            disabled={saveCode.isPending}
            onClick={() => removeToken.mutate()}
          >
            Remove device token
          </Button>
        )}
      </div>
    </div>
  );
}

ConnectSetupCodeForm.propTypes = {
  /** Backdrop the form sits on: page bg (`primary`) or card (`secondary`). */
  surface: PropTypes.oneOf(["primary", "secondary"]),
  compact: PropTypes.bool,
};
