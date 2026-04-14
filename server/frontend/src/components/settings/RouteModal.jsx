import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X, CheckCircle2, XCircle, Network } from "lucide-react";
import PropTypes from "prop-types";
import Card from "../cards/Card";
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

export default function RouteModal({ open, onClose, mode, route, defaultDomain, onSuccess }) {
  const { request } = useAuth();
  const [formData, setFormData] = useState({
    subdomain: "",
    domain: "",
    backend: "",
    ssl: true,
    enabled: true,
  });
  const [loading, setLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [errors, setErrors] = useState({});
  const [isClosing, setIsClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const shouldRender = open || isClosing;
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousFocusRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      setConfirmClose(false);
      setErrors({});
      setTestResult(null);
      return;
    }

    if (mode === "create") {
      setFormData({
        subdomain: "",
        domain: defaultDomain || "",
        backend: "",
        ssl: true,
        enabled: true,
      });
    } else if (mode === "edit" && route) {
      const fullDomain = route.domain || "";
      setFormData({
        subdomain: route.subdomain ? `${route.subdomain}.${fullDomain}` : "",
        domain: fullDomain,
        backend: route.backend || "",
        ssl: route.ssl !== false,
        enabled: route.enabled !== false,
      });
    }
  }, [mode, route, defaultDomain, open]);

  const handleCloseAttempt = useCallback(() => {
    if (loading) {
      setConfirmClose(true);
      return;
    }
    setIsClosing(true);
    setTimeout(() => {
      onClose?.();
      setIsClosing(false);
    }, 200);
  }, [loading, onClose]);

  const handleForceClose = useCallback(() => {
    abortRef.current?.abort();
    setIsClosing(true);
    setTimeout(() => {
      onClose?.();
      setIsClosing(false);
    }, 200);
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement;
    document.body.style.overflow = "hidden";
    setTimeout(() => closeButtonRef.current?.focus(), 50);

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleCloseAttempt();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [open, handleCloseAttempt]);

  const handleChange = useCallback((field) => (e) => {
    setFormData((prev) => ({ ...prev, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: "" }));
    setTestResult(null);
  }, []);

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

    if (!formData.backend.trim()) {
      newErrors.backend = "Backend address is required";
    } else if (!/^https?:\/\/.+/.test(formData.backend.trim())) {
      newErrors.backend = "Backend must be a valid HTTP or HTTPS URL";
    }

    return newErrors;
  }, [formData, mode]);

  const handleTestBackend = useCallback(async () => {
    if (!formData.backend.trim()) {
      setErrors((prev) => ({ ...prev, backend: "Enter a backend address first" }));
      return;
    }
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await request("/network/test-backend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: formData.backend }),
      });
      const data = await res.json();
      setTestResult(data.reachable
        ? { success: true, message: "Backend is reachable" }
        : { success: false, message: data.error || "Backend is not reachable" }
      );
    } catch {
      setTestResult({ success: false, message: "Connection test failed" });
    } finally {
      setTestLoading(false);
    }
  }, [formData.backend, request]);

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
          backend: formData.backend.trim(),
          ssl: formData.ssl,
        };
        method = "POST";
        endpoint = "/network/routes";
      } else {
        body = {
          backend: formData.backend.trim(),
          ssl: formData.ssl,
          enabled: formData.enabled,
        };
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
        setIsClosing(true);
        setTimeout(() => {
          onClose?.();
          setIsClosing(false);
        }, 200);
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

  if (!shouldRender) return null;

  const title = mode === "create" ? "Add Route" : "Edit Route";
  const submitLabel = mode === "create" ? "Add Route" : "Save Changes";

  return createPortal(
    <div
      className={`fixed inset-0 bg-primary/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 ${isClosing ? "animate-out fade-out" : "animate-in fade-in"}`}
      onClick={handleCloseAttempt}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-w-md w-full max-h-[90vh] overflow-y-auto"
        onClick={(event) => event.stopPropagation()}
      >
        <Card noHeightAnim noPopIn className={isClosing ? "pop-out" : "pop-in"} padding={false}>
          <div className="flex items-center justify-between px-6 py-4 border-b border-primary/10">
            <div className="flex items-center gap-2">
              <Network size={18} className="text-accent" />
              <h2 id={titleId} className="font-mono font-normal text-primary">{title}</h2>
            </div>
            <button
              onClick={handleCloseAttempt}
              className="text-primary/60 hover:text-primary transition-colors rounded-pill p-1 focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          {confirmClose && (
            <div className="mx-6 mt-4 bg-warning/10 border border-warning/30 rounded-card p-3">
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

          <form onSubmit={handleSubmit} className="px-6 py-5">
            {mode === "create" && (
              <>
                <p className="text-xs text-accent mb-4">
                  Create a new network route to expose an app or service on a custom domain.
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

            <InputField label="Backend Address" id="backend" error={errors.backend} required>
              <div className="relative">
                <input
                  id="backend"
                  type="text"
                  value={formData.backend}
                  onChange={handleChange("backend")}
                  placeholder="e.g. http://localhost:8080"
                  disabled={loading}
                  className={`w-full pl-4 pr-[4.5rem] py-2 border-2 rounded-pill bg-secondary text-primary placeholder:text-primary/40 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none ${errors.backend ? "border-error focus:border-error focus:ring-2 focus:ring-error/30" : "border-primary/30 focus:border-accent focus:ring-2 focus:ring-accent/30"}`}
                />
                <button
                  type="button"
                  onClick={handleTestBackend}
                  disabled={testLoading || !formData.backend.trim()}
                  className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5 px-3 py-1 text-xs rounded-pill bg-primary/10 text-accent hover:bg-primary/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-mono focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {testLoading ? <Loader2 size={12} className="animate-spin" /> : "Test"}
                </button>
              </div>
              {testResult && (
                <div className={`mt-2 flex items-center gap-2 px-3 py-2 rounded-pill ${testResult.success ? "bg-success/10 text-success" : "bg-error/10 text-error"}`}>
                  {testResult.success ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  <span className="text-xs font-mono">{testResult.message}</span>
                </div>
              )}
            </InputField>

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
                onClick={handleCloseAttempt}
                disabled={loading}
                className="flex-1 px-4 py-2 rounded-pill bg-primary/10 text-primary hover:bg-primary/20 transition-all font-mono text-sm disabled:opacity-50"
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
        </Card>
      </div>
    </div>,
    document.body,
  );
}

RouteModal.propTypes = {
  open: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  mode: PropTypes.oneOf(["create", "edit"]).isRequired,
  route: PropTypes.object,
  defaultDomain: PropTypes.string,
  onSuccess: PropTypes.func,
};
