import { memo, useState, useCallback, useMemo } from "react";
import { Globe, Check, AlertTriangle, Loader2 } from "lucide-react";
import PropTypes from "prop-types";

function SubdomainStep({ app, domain, onSubdomainChange, onContinue, onBack, loading }) {
  const [subdomain, setSubdomain] = useState("");
  const [subdomainError, setSubdomainError] = useState(null);
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState(null);

  // Generate suggested subdomain from app name
  const suggested = useMemo(() => {
    if (!app?.name) return "";
    return app.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-")
      .substring(0, 50);
  }, [app?.name]);

  // Validate subdomain format
  const validateSubdomain = useCallback((value) => {
    if (!value.trim()) {
      setSubdomainError("Subdomain is required");
      return false;
    }

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value)) {
      setSubdomainError(
        "Subdomain must start and end with a letter or number, and can contain letters, numbers, and hyphens"
      );
      return false;
    }

    if (value.length > 63) {
      setSubdomainError("Subdomain must be 63 characters or less");
      return false;
    }

    setSubdomainError(null);
    return true;
  }, []);

  // Check availability
  const checkAvailability = useCallback(async () => {
    if (!domain || !subdomain.trim()) return;

    setChecking(true);
    setSubdomainError(null);

    try {
      const res = await fetch("/api/v1/network/routes/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain, domain }),
      });
      const data = await res.json();
      setAvailable(data.available);
      if (!data.available) {
        setSubdomainError(data.error || "Subdomain is already in use");
      }
    } catch (err) {
      setSubdomainError("Failed to check availability");
    } finally {
      setChecking(false);
    }
  }, [subdomain, domain]);

  // Handle subdomain change
  const handleSubdomainChange = useCallback(
    (e) => {
      const value = e.target.value;
      setSubdomain(value);
      setAvailable(null);

      if (value) {
        validateSubdomain(value);
      } else {
        setSubdomainError(null);
      }
    },
    [validateSubdomain]
  );

  // Check availability on blur
  const handleBlur = useCallback(() => {
    if (subdomain.trim() && validateSubdomain(subdomain)) {
      checkAvailability();
    }
  }, [subdomain, checkAvailability, validateSubdomain]);

  // Continue to install
  const handleContinue = useCallback(() => {
    if (validateSubdomain(subdomain)) {
      onSubdomainChange(subdomain);
      onContinue();
    }
  }, [subdomain, validateSubdomain, onSubdomainChange, onContinue]);

  const isNextEnabled = subdomain.trim() && !subdomainError && available === true;

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h2 className="font-mono text-2xl font-normal text-secondary">Choose Subdomain</h2>
        <p className="text-secondary/70 text-sm">
          Select a subdomain for your app. It will be accessible at{" "}
          <span className="font-mono text-accent">{subdomain}.{domain}</span>
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="subdomain" className="block font-mono text-sm text-secondary">
            Subdomain
          </label>
          <input
            id="subdomain"
            type="text"
            value={subdomain}
            onChange={handleSubdomainChange}
            onBlur={handleBlur}
            disabled={loading}
            placeholder={suggested || "e.g., myapp"}
            className="w-full px-4 py-3 rounded-large-element border-2 border-secondary/30 bg-primary text-secondary placeholder:text-secondary/25 font-mono text-sm focus:outline-none focus:border-accent focus-visible:ring-2 focus:ring-accent focus-visible:ring-offset-2"
            autoComplete="off"
          />
          {subdomainError && (
            <p className="text-xs text-error mt-1.5">{subdomainError}</p>
          )}
        </div>

        {suggested && subdomain !== suggested && (
          <button
            type="button"
            onClick={() => {
              setSubdomain(suggested);
              handleSubdomainChange({ target: { value: suggested } });
            }}
            className="text-xs font-mono text-secondary/50 hover:text-secondary/80 underline"
          >
            Use suggested: {suggested}
          </button>
        )}

        {checking && (
          <div className="flex items-center gap-2 text-sm text-secondary/70">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Checking availability...</span>
          </div>
        )}

        {available === false && !subdomainError && (
          <div className="flex items-start gap-2 p-3 rounded-large-element bg-error/10 border border-error/30">
            <AlertTriangle className="w-4 h-4 text-error mt-0.5 flex-shrink-0" />
            <p className="text-xs text-error/80">This subdomain is already in use</p>
          </div>
        )}

        {available === true && (
          <div className="flex items-start gap-2 p-3 rounded-large-element bg-success/10 border border-success/30">
            <Check className="w-4 h-4 text-success mt-0.5 flex-shrink-0" />
            <p className="text-xs text-success/80">This subdomain is available</p>
          </div>
        )}
      </div>

      <div className="flex justify-center gap-3 pt-4">
        <button
          type="button"
          onClick={onBack}
          disabled={loading}
          className="px-6 py-2 rounded-pill border-2 border-secondary/30 text-secondary hover:bg-secondary/10 motion-safe:transition-all font-mono"
        >
          Back
        </button>
        <button
          type="button"
          onClick={handleContinue}
          disabled={!isNextEnabled || loading}
          className="px-6 py-2 rounded-pill bg-secondary text-primary hover:bg-secondary/90 motion-safe:transition-all font-mono"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

SubdomainStep.propTypes = {
  app: PropTypes.object,
  domain: PropTypes.string,
  onSubdomainChange: PropTypes.func.isRequired,
  onContinue: PropTypes.func.isRequired,
  onBack: PropTypes.func.isRequired,
  loading: PropTypes.bool,
};

export default memo(SubdomainStep);