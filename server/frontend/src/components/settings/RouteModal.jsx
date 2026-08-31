import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Globe, XCircle } from "lucide-react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard";
import Dropdown from "../common/Dropdown";
import Toggle from "../common/Toggle";
import Button from "../ui/Button";
import { useAuth } from "../../hooks/useAuth";
import { cn } from "@/lib/utils";
import { testBackend } from "../../lib/network-api";

// "Manual address" is the default app-picker option; choosing a running app
// fills the destination for you. The route itself never requires an app.
const MANUAL = "__manual__";

const HOST_PORT_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?:\d{1,5}$/;
const URL_RE = /^https?:\/\//i;
const UNIX_RE = /^unix:\/\//i;

// Matches what the backend accepts: host:port (e.g. localhost:8080),
// http(s):// URLs, or unix:// sockets.
function looksValidDestination(value) {
  const v = (value || "").trim();
  if (!v || /\s/.test(v)) return false;
  return HOST_PORT_RE.test(v) || URL_RE.test(v) || UNIX_RE.test(v);
}

/**
 * Add / edit a network route. Creating a route is just: a subdomain, a
 * domain, and the address on this device it should forward to (host:port).
 * No app has to be running — linking a running app is an optional shortcut
 * that fills in the address for you.
 *
 * @param {{ open: boolean, onClose: any, mode: string, route?: any, defaultDomain?: any, apps?: any[], onSuccess?: any }} _
 */
export default function RouteModal({ open, onClose, mode, route, defaultDomain, apps, onSuccess }) {
  const { request } = useAuth();
  const [formData, setFormData] = useState({
    subdomain: "",
    domain: "",
    appId: MANUAL,
    backendName: "",
    destination: "",
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
  const selectedApp = apps?.find((app) => app.id === formData.appId);
  const appBackends = selectedApp?.backends || [];
  const showBackendPicker = appBackends.length > 1;
  const selectedBackend = appBackends.find((b) => b.name === formData.backendName) || appBackends[0];
  // Auto-test only when the destination came from a picked app (a known-good
  // address); while typing manually, the Test button is the trigger.
  const autoTest = formData.appId !== MANUAL && Boolean(selectedBackend?.url);

  const appOptions = useMemo(
    () => [
      { value: MANUAL, label: "Manual address (host:port)" },
      ...runningApps.map((app) => ({ value: app.id, label: app.name })),
    ],
    [runningApps]
  );

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
    const routeBackend = route?.backend;
    const routeEnabled = route?.enabled;
    const formKey = `${mode}-${routeId}-${defaultDomain}-${routeAppId}-${routeBackend}-${routeEnabled}`;
    if (prevFormKeyRef.current !== formKey) {
      prevFormKeyRef.current = formKey;
      if (mode === "create") {
        setFormData({
          subdomain: "",
          domain: defaultDomain || "",
          appId: MANUAL,
          backendName: "",
          destination: "",
          enabled: true,
        });
      } else if (route) {
        setFormData({
          subdomain: routeSubdomain ? `${routeSubdomain}.${routeDomain}` : "",
          domain: routeDomain || "",
          appId: routeAppId || MANUAL,
          backendName: "",
          destination: routeBackend || "",
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
    if (autoTest && open && !loading) {
      testDebounceRef.current = setTimeout(() => {
        doTestBackend(selectedBackend.url);
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
  }, [autoTest, selectedBackend, open, loading, doTestBackend]);

  const handleChange = useCallback((field) => (e) => {
    const value = e.target.value;
    setFormData((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "appId") {
        if (value === MANUAL) {
          // Switching back to manual keeps whatever address was typed.
          next.backendName = "";
        } else {
          const app = apps?.find((a) => a.id === value);
          next.backendName = app?.backends?.[0]?.name || "";
          next.destination = app?.backends?.[0]?.url || next.destination;
        }
      }
      if (field === "backendName") {
        const app = apps?.find((a) => a.id === formData.appId);
        const backend = app?.backends?.find((b) => b.name === value);
        if (backend) next.destination = backend.url;
      }
      return next;
    });
    setErrors((prev) => ({ ...prev, [field]: "", destination: "" }));
  }, [apps, formData.appId]);

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
    }

    if (!formData.destination.trim()) {
      newErrors.destination = "Enter the address on this device to forward to";
    } else if (!looksValidDestination(formData.destination)) {
      newErrors.destination = "Enter it as host:port — for example localhost:8080";
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
          backend: formData.destination.trim(),
          ssl: true,
        });
        if (formData.appId !== MANUAL) {
          body.app_id = formData.appId;
          if (formData.backendName) body.backend_name = formData.backendName;
        }
        method = "POST";
        endpoint = "/network/routes";
      } else {
        body = /** @type {{ [key: string]: any }} */ ({
          backend: formData.destination.trim(),
          enabled: formData.enabled,
        });
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

      <form onSubmit={handleSubmit}>
        {mode === "create" ? (
          <>
            <p className="text-xs text-primary/50 mb-6 leading-relaxed">
              Give this subdomain its own address on the internet: anyone who
              opens it is sent to the address on this device you choose below.
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
        ) : (
          route && (
            <div className="mb-5 flex items-center gap-2 px-4 py-2.5 rounded-large-element bg-primary/5">
              <Globe size={16} className="text-primary/50 shrink-0" />
              <p className="font-mono text-sm text-primary truncate">
                {route.subdomain ? `${route.subdomain}.${route.domain}` : route.domain}
              </p>
            </div>
          )
        )}

        {/* Destination — the one thing a route actually needs. */}
        <div className="rounded-large-element bg-primary/5 border border-primary/10 p-4 space-y-3">
          <div>
            <label
              htmlFor="destination"
              className="text-primary font-sans text-sm text-left translate-x-5 motion-safe:transition-all mb-1.5 block"
            >
              Forward to<span className="text-error ml-0.5">*</span>
            </label>
            <div className="flex gap-2">
              <input
                id="destination"
                type="text"
                value={formData.destination}
                onChange={handleChange("destination")}
                placeholder="localhost:8080"
                spellCheck={false}
                autoComplete="off"
                disabled={loading}
                className={cn("flex-1 min-w-0 px-4 py-2 border-2 rounded-pill bg-secondary text-primary placeholder:text-primary/50 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none", errors.destination && "border-error focus:border-error focus:ring-2 focus:ring-error/30", !errors.destination && "border-primary/20 focus:border-accent focus:ring-2 focus:ring-accent/30")}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => doTestBackend(formData.destination.trim())}
                disabled={loading || !looksValidDestination(formData.destination)}
                loading={testingBackend}
                className="whitespace-nowrap shrink-0"
              >
                {testingBackend ? "Testing..." : "Test"}
              </Button>
            </div>
            <p className="text-xs text-primary/50 mt-2 leading-relaxed">
              The address on this device that should answer for this subdomain.
              Use <span className="font-mono">localhost:8080</span> for a service
              on this device, or an IP like <span className="font-mono">192.168.1.50:3000</span>.
            </p>
            {errors.destination && (
              <p className="text-error text-xs mt-1">{errors.destination}</p>
            )}
            {backendTestResult && (
              <div className={cn("flex items-center gap-1.5 text-xs mt-2", backendTestResult.reachable ? "text-success" : "text-error")}>
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

          {mode === "create" && runningApps.length > 0 && (
            <div className="border-t border-primary/10 pt-3">
              <label className="text-primary font-sans text-sm mb-1 block">
                Or use a running app
              </label>
              <Dropdown
                value={formData.appId}
                onChange={(val) => handleChange("appId")({ target: { value: val } })}
                placeholder="Choose an app..."
                fullWidth
                disabled={loading}
                bg="primary"
                options={appOptions}
              />
              {showBackendPicker && (
                <div className="mt-2">
                  <label className="text-primary font-sans text-sm mb-1 block">
                    Backend
                  </label>
                  <Dropdown
                    value={formData.backendName}
                    onChange={(val) => handleChange("backendName")({ target: { value: val } })}
                    fullWidth
                    disabled={loading}
                    bg="primary"
                    options={appBackends.map((backend) => ({
                      value: backend.name,
                      label: backend.name ? `${backend.name} — ${backend.url}` : backend.url,
                    }))}
                  />
                </div>
              )}
            </div>
          )}

          {mode === "edit" && selectedApp && (
            <p className="text-xs text-primary/50">
              This route belongs to <span className="font-mono text-primary">{selectedApp.name}</span>.
            </p>
          )}
        </div>

        <div className="space-y-3 mb-5 mt-4 p-4 rounded-large-element bg-primary/5 border border-primary/10">
          {mode === "edit" ? (
            <Toggle
              checked={formData.enabled}
              onChange={(val) => setFormData((prev) => ({ ...prev, enabled: val }))}
              label="Enabled"
              description="Route is active and handling traffic"
              disabled={loading}
            />
          ) : (
            <p className="text-xs text-primary/50 leading-relaxed">
              The route is enabled as soon as it's created, with automatic HTTPS.
            </p>
          )}
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
