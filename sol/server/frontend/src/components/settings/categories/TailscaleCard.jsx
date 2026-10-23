import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import TailscaleSettings from "@libreloom/ui/components/settings/TailscaleCard.jsx";
import api, { apiErrorMessage } from "../../../lib/api.js";

export default function TailscaleCard() {
  const { addToast } = useToast();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const requestVersion = useRef(0);
  const changing = useRef(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (changing.current) return;
    const version = ++requestVersion.current;
    try {
      const res = await api("/network/tailscale/status");
      const data = await res.json();
      if (version === requestVersion.current) {
        setStatus(data);
        setError("");
      }
    } catch (err) {
      if (version === requestVersion.current)
        setError(apiErrorMessage(err, "Sol could not read Tailscale status."));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(refresh, status?.state === "error" || error ? 60000 : 15000);
    return () => window.clearInterval(timer);
  }, [refresh, status?.state, error]);
  const run = async (action, body = {}) => {
    changing.current = true;
    ++requestVersion.current;
    setBusy(true);
    setActionError("");
    try {
      const res = await api(`/network/tailscale/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setStatus(data);
      addToast({
        type: data.residual_exposure ? "error" : "success",
        message:
          data.residual_exposure ? "Tailscale could not be stopped" : data.auth_url || data.approval_url
            ? "Tailscale approval link ready"
            : "Tailscale settings updated",
      });
    } catch (err) {
      setActionError(
        apiErrorMessage(err, "Sol could not change Tailscale access."),
      );
    } finally {
      changing.current = false;
      setBusy(false);
    }
  };
  return (
    <TailscaleSettings
      product="Sol"
      status={status || {}}
      loading={!status && !error}
      busy={busy}
      error={actionError || error}
      onAction={(action, body) => {
        void run(action, body);
      }}
    />
  );
}
