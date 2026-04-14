import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Network } from "lucide-react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard";
import Dropdown from "../common/Dropdown";
import Toggle from "../common/Toggle";
import { useAuth } from "../../hooks/useAuth";

function InputField({ label, id, error, required, children }) {
  return (
    <div className="mb-4">
      {label && (
        <label
          htmlFor={id}
          className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block"
        >
          {label}
          {required && <span className="text-error ml-1">*</span>}
        </label>
      )}
      {children}
      {error && (
        <p id={`${id}-error`} className="text-error text-xs mt-1 px-5">
          {error}
        </p>
      )}
    </div>
  );
}

export default function RouteModal({ open, onClose, mode, route, defaultDomain, apps, onSuccess }) {
  const { request } = useAuth();
  const [formData, setFormData] = useState({
    subdomain: "",
    domain: "",
    appId: "",
    backendName: "",
    ssl: true,
    enabled: true,
  });
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({});
  const [isClosing, setIsClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const abortRef = useRef(null);
  const prevFormKeyRef = useRef(null);

  const runningApps = useMemo(() => apps?.filter((app) => app.status === "running") || [], [apps]);
  const noAppsError = mode === "create" && apps !== null && runningApps.length === 0;

  const selectedApp = apps?.find((app) => app.id === formData.appId);
  const appBackends = selectedApp?.backends || [];
  const showBackendPicker = appBackends.length > 1;
  const selectedBackend = appBackends.find((b) => b.name === formData.backendName) || appBackends[0];

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      /* eslint-disable react-hooks/set-state-in-effect */
      setConfirmClose(false);
      setErrors({});
      prevFormKeyRef.current = null;
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    const routeId = route?.id;
    const routeAppId = route?.app_id;
    const routeDomain = route?.domain;
    const routeSubdomain = route?.subdomain;
    const routeBackendName = route?.backend_name;
    const routeSsl = route?.ssl;
    const routeEnabled = route?.enabled;
    const formKey = `${mode}-${routeId}-${defaultDomain}-${routeAppId}-${routeSsl}-${routeEnabled}`;
    if (prevFormKeyRef.current !== formKey) {
      prevFormKeyRef.current = formKey;
      if (mode === "create") {
        setFormData({
          subdomain: "",
          domain: defaultDomain || "",
          appId: "",
          backendName: "",
          ssl: true,
          enabled: true,
        });
      } else if (route) {
        const fullDomain = routeDomain || "";
        setFormData({
          subdomain: routeSubdomain ? `${routeSubdomain}.${fullDomain}` : "",
          domain: fullDomain,
          appId: routeAppId || "",
          backendName: routeBackendName || "",
          ssl: routeSsl !== false,
          enabled: routeEnabled !== false,
        });
      }
    }
  }, [open, mode, route, defaultDomain]);

  const handleClose = useCallback(() => {
    if (loading || isClosing) {
      setConfirmClose(true);
      return;
    }
    setIsClosing(true);
    setTimeout(() => {
      onClose?.();
      setIsClosing(false);
    }, 200);
  }, [loading, isClosing, onClose]);

  const handleForceClose = useCallback(() => {
    abortRef.current?.abort();
    setIsClosing(true);
    setTimeout(() => {
      onClose?.();
      setIsClosing(false);
    }, 200);
  }, [onClose]);

  const handleChange = useCallback((field) => (e) => {
    const value = e.target.value;
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "appId") {
        const app = apps?.find((a) => a.id === value);
        next.backendName = app?.backends?.[0]?.name || "";
      }
      return next;
    });
    setErrors((prev) => ({ ...prev, [field]: "" }));
  }, [apps]);

  const validateForm = useCallback(() => {
    const newErrors = {};

    if (mode === "create") {
      if (!formData.subdomain.trim()) {
        newErrors.subdomain = "Subdomain is required";
      } else if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(formData.subdomain.trim())) {
        newErrors.subdomain = "Subdomain must be alphanumeric with optional hyphens";
      }

      if (!formData.domain.trim()) {
        newErrors.domain = "Domain is required";
      } else if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(formData.domain.trim())) {
        newErrors.domain = "Enter a valid domain (e.g. example.com)";
      }

      if (!formData.appId) {
        newErrors.appId = "Select an app";
      }
    } else {
      if (!formData.appId) {
        newErrors.appId = "Select an app";
      }
    }

    return newErrors;
  }, [formData, mode]);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    const validationErrors = validateForm();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setLoading(true);
    setErrors({});
    abortRef.current = new AbortController();

    try {
      let body;
      let method;
      let endpoint;

      if (mode === "create") {
        body = {
          subdomain: formData.subdomain.trim(),
          domain: formData.domain.trim(),
          app_id: formData.appId,
          ssl: formData.ssl,
        };
        if (formData.backendName) {
          body.backend_name = formData.backendName;
        }
        method = "POST";
        endpoint = "/network/routes";
      } else {
        body = {
          app_id: formData.appId,
          ssl: formData.ssl,
          enabled: formData.enabled,
        };
        if (formData.backendName) {
          body.backend_name = formData.backendName;
        }
        method = "PUT";
        endpoint = `/network/routes/${route.id}`;
      }

      const response = await request(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortRef.current?.signal,
      });

      const result = await response.json();
      if (response.ok) {
        onSuccess?.(result);
        onClose?.();
      } else {
        setErrors({ form: result.message || "Failed to save route" });
        setLoading(false);
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      const status = err.cause?.status;
      if (status === 409) {
        setErrors({ form: "A route with this subdomain and domain already exists" });
      } else if (status === 400) {
        setErrors({ form: err.message || "Invalid input" });
      } else {
        setErrors({ form: "Failed to save route. Please try again." });
      }
      setLoading(false);
    }
  }, [formData, mode, route, request, validateForm, onSuccess, onClose]);

  if (!open && !isClosing) return null;

  const title = mode === "create" ? "Add Route" : "Edit Route";
  const submitLabel = mode === "create" ? "Add Route" : "Save Changes";

  return (
    <ModalCard
      title={title}
      onClose={handleClose}
      className={isClosing ? "animate-out fade-out" : "animate-in fade-in"}
    >
      {confirmClose && (
        <div className="mb-4 bg-warning/10 border border-warning/30 rounded-card p-3">
          <p className="font-mono text-xs text-warning mb-3">Route is being saved. Cancel?</p>
          <div className="flex gap-2">
            <button
              onClick={() => setConfirmClose(false)}
              className="flex-1 px-3 py-1.5 rounded-pill bg-primary/10 text-primary text-xs font-mono hover:bg-primary/20 transition-colors"
            >
              Continue Saving
            </button>
            <button
              onClick={handleForceClose}
              className="flex-1 px-3 py-1.5 rounded-pill bg-warning/20 text-warning text-xs font-mono hover:bg-warning/30 transition-colors"
            >
              Cancel &amp; Close
            </button>
          </div>
        </div>
      )}

      {noAppsError ? (
        <div className="text-center py-4">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Network size={18} className="text-accent" />
            <p className="font-mono text-sm text-primary">No running apps available</p>
          </div>
          <p className="text-xs text-accent mb-6">
            Install and start an app before creating a network route.
          </p>
          <button
            type="button"
            onClick={handleClose}
            className="w-full px-4 py-2 rounded-pill border-2 border-accent/30 bg-secondary text-primary hover:bg-accent/20 transition-all font-mono text-sm"
          >
            Close
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          {mode === "create" && (
            <>
              <p className="text-xs text-accent mb-4">
                Create a new network route to expose an app on a custom domain.
              </p>
              <InputField label="Subdomain" id="subdomain" error={errors.subdomain} required>
                <input
                  id="subdomain"
                  type="text"
                  value={formData.subdomain}
                  onChange={handleChange("subdomain")}
                  placeholder="e.g. nextcloud"
                  disabled={loading}
                  className={`w-full px-4 py-2 border-2 rounded-pill bg-secondary text-primary placeholder:text-primary/40 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none ${errors.subdomain ? "border-error focus:border-error focus:ring-2 focus:ring-error/30" : "border-primary/30 focus:border-accent focus:ring-2 focus:ring-accent/30"}`}
                />
              </InputField>

              <InputField label="Domain" id="domain" error={errors.domain} required>
                <input
                  id="domain"
                  type="text"
                  value={formData.domain}
                  onChange={handleChange("domain")}
                  placeholder={defaultDomain || "e.g. example.com"}
                  disabled={loading}
                  className={`w-full px-4 py-2 border-2 rounded-pill bg-secondary text-primary placeholder:text-primary/40 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none ${errors.domain ? "border-error focus:border-error focus:ring-2 focus:ring-error/30" : "border-primary/30 focus:border-accent focus:ring-2 focus:ring-accent/30"}`}
                />
              </InputField>
            </>
          )}

          {mode === "edit" && route && (
            <div className="mb-4">
              <p className="text-xs text-accent mb-1">Domain</p>
              <p className="font-mono text-sm text-primary bg-primary/10 rounded-pill px-4 py-2">
                {route.subdomain ? `${route.subdomain}.${route.domain}` : route.domain}
              </p>
            </div>
          )}

          <div className="mb-4">
            <label className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block">
              App<span className="text-error ml-1">*</span>
            </label>
            <Dropdown
              value={formData.appId}
              onChange={(val) => handleChange("appId")({ target: { value: val } })}
              placeholder="Select an app..."
              fullWidth
              disabled={loading}
              options={runningApps.map((app) => ({ value: app.id, label: app.name }))}
            />
            {errors.appId && (
              <p className="text-error text-xs mt-1 px-5">{errors.appId}</p>
            )}
          </div>

          {selectedApp && (
            <div className="mb-4">
              {showBackendPicker ? (
                <>
                  <label className="text-accent font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1 block">
                    Backend
                  </label>
                  <Dropdown
                    value={formData.backendName}
                    onChange={(val) => handleChange("backendName")({ target: { value: val } })}
                    fullWidth
                    disabled={loading}
                    options={appBackends.map((backend) => ({
                      value: backend.name,
                      label: backend.name ? `${backend.name} — ${backend.url}` : backend.url,
                    }))}
                  />
                  {errors.backendName && (
                    <p className="text-error text-xs mt-1 px-5">{errors.backendName}</p>
                  )}
                </>
              ) : (
                <div>
                  <p className="text-xs text-accent mb-1">Backend</p>
                  <p className="font-mono text-sm text-primary bg-primary/10 rounded-pill px-4 py-2">
                    {selectedBackend?.url || "No backend available"}
                  </p>
                </div>
              )}
            </div>
          )}

          {selectedBackend && !showBackendPicker && (
            <p className="text-xs text-accent -mt-2 mb-4">
              Route: {selectedBackend.url}
            </p>
          )}

          <div className="space-y-3 mb-6">
            <Toggle
              checked={formData.enabled}
              onChange={(val) => setFormData((prev) => ({ ...prev, enabled: val }))}
              label="Enabled"
              description="Route is active and handling traffic"
              disabled={loading}
            />
            <Toggle
              checked={formData.ssl}
              onChange={(val) => setFormData((prev) => ({ ...prev, ssl: val }))}
              label="Enable SSL"
              description="Request and renew TLS certificate automatically"
              disabled={loading}
            />
          </div>

          {errors.form && (
            <div className="mb-4 bg-error/10 border border-error/30 rounded-pill px-4 py-2 text-error text-sm text-center">
              {errors.form}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={loading}
              className="flex-1 px-4 py-2 rounded-pill border-2 border-accent/30 bg-secondary text-primary hover:bg-accent/20 transition-all font-mono text-sm disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 hover:ring-accent transition-all font-mono text-sm disabled:opacity-50"
            >
              {loading && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
              {loading ? "Saving..." : submitLabel}
            </button>
          </div>
        </form>
      )}
    </ModalCard>
  );
}

RouteModal.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  mode: PropTypes.oneOf(["create", "edit"]).isRequired,
  route: PropTypes.object,
  defaultDomain: PropTypes.string,
  apps: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    status: PropTypes.string,
    backends: PropTypes.arrayOf(PropTypes.shape({
      name: PropTypes.string,
      url: PropTypes.string.isRequired,
    })),
  })),
  onSuccess: PropTypes.func,
};