import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Globe, Network, XCircle } from "lucide-react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard";
import Dropdown from "../common/Dropdown";
import Toggle from "../common/Toggle";
import Button from "../ui/Button";
import { useAuth } from "../../hooks/useAuth";
import { cn } from "@/lib/utils";
import { testBackend } from "../../lib/network-api";

/**
 * @param {{ open: boolean, onClose: any, mode: string, route?: any, defaultDomain?: any, apps?: any[], onSuccess?: any }} _
 */
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
  const [errors, setErrors] = useState(/** @type {Record<string, string>} */ ({}));
  const [isClosing, setIsClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [testingBackend, setTestingBackend] = useState(false);
  const [backendTestResult, setBackendTestResult] = useState(null);
  const abortRef = useRef(null);
  const prevFormKeyRef = useRef(null);
  const testDebounceRef = useRef(null);

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
      if (testDebounceRef.current) {
        clearTimeout(testDebounceRef.current);
        testDebounceRef.current = null;
      }
      setConfirmClose(false);
      setErrors({});
      setTestingBackend(false);
      setBackendTestResult(null);
      prevFormKeyRef.current = null;
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
    if (testDebounceRef.current) {
      clearTimeout(testDebounceRef.current);
      testDebounceRef.current = null;
    }
    setIsClosing(true);
    setTimeout(() => {
      onClose?.();
      setIsClosing(false);
    }, 200);
  }, [onClose]);

  const doTestBackend = useCallback(async (backendUrl) => {
    if (!backendUrl) {
      setBackendTestResult(null);
      return;
    }
    setTestingBackend(true);
    setBackendTestResult(null);
    try {
      const result = await testBackend(backendUrl);
      setBackendTestResult(result);
    } catch {
      setBackendTestResult({ reachable: false, error: "Failed to connect" });
    } finally {
      setTestingBackend(false);
    }
  }, []);

  useEffect(() => {
    if (testDebounceRef.current) {
      clearTimeout(testDebounceRef.current);
    }
    const backendUrl = selectedBackend?.url;
    if (backendUrl && open && !loading) {
      testDebounceRef.current = setTimeout(() => {
        doTestBackend(backendUrl);
      }, 500);
    } else {
      setBackendTestResult(null);
    }
    return () => {
      if (testDebounceRef.current) {
        clearTimeout(testDebounceRef.current);
        testDebounceRef.current = null;
      }
    };
  }, [selectedBackend, open, loading, doTestBackend]);

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
      setErrors(/** @type {any} */ (validationErrors));
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
        body = /** @type {{ [key: string]: any }} */ ({
          subdomain: formData.subdomain,
          domain: formData.domain,
          app_id: formData.appId,
          ssl: formData.ssl,
        });
        if (formData.backendName) {
          body.backend_name = formData.backendName;
        }
        method = "POST";
        endpoint = "/network/routes";
      } else {
        body = /** @type {{ [key: string]: any }} */ ({
          app_id: formData.appId,
          ssl: formData.ssl,
          enabled: formData.enabled,
        });
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
      className={cn(isClosing ? "animate-out fade-out" : "animate-in fade-in")}
    >
      {confirmClose && (
        <div className="mb-4 bg-warning/10 border border-warning/30 rounded-large-element p-3">
          <p className="font-mono text-xs text-warning mb-3">Route is being saved. Cancel?</p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmClose(false)}
              className="flex-1"
            >
              Continue Saving
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={handleForceClose}
              className="flex-1"
            >
              Cancel &amp; Close
            </Button>
          </div>
        </div>
      )}

      {noAppsError ? (
        <div className="text-center py-12">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 mb-4">
            <Network size={24} className="text-primary/50" />
          </div>
          <p className="font-mono text-sm text-primary mb-1">No running apps</p>
          <p className="text-xs text-primary/50 mb-6">
            Install and start an app before creating a route.
          </p>
          <Button
            type="button"
            variant="outline"
            fullWidth
            onClick={handleClose}
          >
            Close
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          {mode === "create" && (
            <>
              <p className="text-xs text-primary/50 mb-6">
                Create a network route to expose an app on a custom domain.
              </p>
              <div className="flex gap-2 mb-5">
                <div className="flex-1">
                  <label
                    htmlFor="subdomain"
                    className="text-primary font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1.5 block"
                  >
                    Subdomain<span className="text-error ml-0.5">*</span>
                  </label>
                  <input
                    id="subdomain"
                    type="text"
                    value={formData.subdomain}
                    onChange={handleChange("subdomain")}
                    placeholder="e.g. nextcloud"
                    disabled={loading}
                    className={cn("w-full px-4 py-2 border-2 rounded-pill bg-secondary text-primary placeholder:text-primary/50 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none", errors.subdomain && "border-error focus:border-error focus:ring-2 focus:ring-error/30", !errors.subdomain && "border-primary/20 focus:border-accent focus:ring-2 focus:ring-accent/30")}
                  />
                  {errors.subdomain && (
                    <p className="text-error text-xs mt-1">{errors.subdomain}</p>
                  )}
                </div>
                <div className="flex items-end pb-2 text-primary font-mono text-lg font-black">.</div>
                <div className="flex-1">
                  <label
                    htmlFor="domain"
                    className="text-primary font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1.5 block"
                  >
                    Domain<span className="text-error ml-0.5">*</span>
                  </label>
                  <input
                    id="domain"
                    type="text"
                    value={formData.domain}
                    onChange={handleChange("domain")}
                    placeholder={defaultDomain || "e.g. example.com"}
                    disabled={loading}
                    className={cn("w-full px-4 py-2 border-2 rounded-pill bg-secondary text-primary placeholder:text-primary/50 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none", errors.domain && "border-error focus:border-error focus:ring-2 focus:ring-error/30", !errors.domain && "border-primary/20 focus:border-accent focus:ring-2 focus:ring-accent/30")}
                  />
                  {errors.domain && (
                    <p className="text-error text-xs mt-1">{errors.domain}</p>
                  )}
                </div>
              </div>
            </>
          )}

          {mode === "edit" && route && (
            <div className="mb-5 flex items-center gap-2 px-4 py-2.5 rounded-large-element bg-primary/5">
              <Globe size={16} className="text-primary/50 shrink-0" />
              <p className="font-mono text-sm text-primary truncate">
                {route.subdomain ? `${route.subdomain}.${route.domain}` : route.domain}
              </p>
            </div>
          )}

          <div className="rounded-large-element bg-primary/5 border border-primary/10 mb-6 p-1">
              <div className="rounded-large-element bg-secondary text-primary border border-primary/10">
                <label className="text-primary font-sans text-sm mb-1 block px-3 pt-3">
                  App<span className="text-error ml-0.5">*</span>
                </label>
                <div className="px-3 pb-3">
                  <Dropdown
                    value={formData.appId}
                    onChange={(val) => handleChange("appId")({ target: { value: val } })}
                    placeholder="Select an app..."
                    fullWidth
                    disabled={loading}
                    options={runningApps.map((app) => ({ value: app.id, label: app.name }))}
                  />
                </div>
                {errors.appId && (
                  <p className="text-error text-xs mt-1 px-3 pb-3">{errors.appId}</p>
                )}
              </div>

              {selectedApp && (
                <div className="rounded-large-element bg-secondary text-primary border border-primary/10 mt-2">
                  <label className="text-primary font-sans text-sm mb-1 block px-3 pt-3">
                    Backend
                  </label>
                  {showBackendPicker ? (
                    <>
                      <div className="px-3 pb-3">
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
                      </div>
                      {errors.backendName && (
                        <p className="text-error text-xs mt-1 px-3 pb-3">{errors.backendName}</p>
                      )}
                    </>
                  ) : (
                    <div className="px-3 pb-3">
                      <p className="font-mono text-sm text-primary bg-primary/10 rounded-pill px-4 py-2 truncate">
                        {selectedBackend?.url || "No backend available"}
                      </p>
                    </div>
                  )}
                  {selectedBackend?.url && (
                    <div className="mt-2 flex items-center gap-2 px-3 pb-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => doTestBackend(selectedBackend.url)}
                        disabled={loading}
                        loading={testingBackend}
                        className="whitespace-nowrap"
                      >
                        {testingBackend ? "Testing..." : "Test Connection"}
                      </Button>
                      {backendTestResult && (
                        <div className={cn("flex items-center gap-1 text-xs", backendTestResult.reachable ? "text-success" : "text-error")}>
                          {backendTestResult.reachable ? (
                            <>
                              <CheckCircle2 size={12} />
                              <span className="font-mono">Reachable</span>
                            </>
                          ) : (
                            <>
                              <XCircle size={12} />
                              <span className="font-mono">{backendTestResult.error || "Unreachable"}</span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

          <div className="space-y-3 mb-5 mt-4 p-4 rounded-large-element bg-primary/5 border border-primary/10">
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

          <div className="flex gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={loading}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={loading}
              className="flex-1"
            >
              {loading ? "Saving..." : submitLabel}
            </Button>
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