import { useState } from "react";
import { ExternalLink, Settings, ArrowRight } from "lucide-react";
import PropTypes from "prop-types";
import Button from "../ui/Button";

const CONNECT_URL = "https://connect.serv.libreloom.org/onboarding";

/**
 * ExternalServicesStep — rendered inside SetupPage's card shell.
 *
 * Gives the user two paths:
 * 1. "Use LibreServ Connect" — opens the Connect onboarding flow in a new tab.
 *    The user creates an account, selects a plan, gets a license key, and pastes
 *    it back here. The device activates and all external services (email, domain,
 *    tunnel, backups) are auto-provisioned through Connect.
 * 2. "Set up manually" — skips to MFA. The user configures each service
 *    individually later in Settings → External Services.
 */
export default function ExternalServicesStep({ onActivate, onSkip }) {
  const [token, setToken] = useState("");
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState("");

  const handleActivate = async () => {
    if (!token.trim()) {
      setError("Please paste your Connect token here.");
      return;
    }
    setActivating(true);
    setError("");
    try {
      await onActivate(token.trim());
    } catch (err) {
      setError(err.message || "Could not connect to LibreServ Connect. Please check your token and try again.");
      setActivating(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleActivate();
    }
  };

  return (
    <>
      <h1 className="font-mono text-2xl text-primary mb-2">
        External Services
      </h1>
      <p className="text-primary/50 text-sm leading-relaxed mb-6">
        Your server needs a few things from the outside world — email, a
        domain name, remote access, and backups. You can set all of these up
        at once through LibreServ Connect, or configure them manually later.
      </p>

      {/* Option 1: Use Connect */}
      <div className="rounded-large-element border-2 border-accent/30 p-5 mb-4 bg-primary/5">
        <div className="flex items-start gap-3 mb-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-pill bg-accent/20 flex items-center justify-center">
            <ExternalLink className="w-4 h-4 text-accent" />
          </div>
          <div>
            <h2 className="font-mono text-base text-primary">
              Use LibreServ Connect
            </h2>
            <p className="text-primary/50 text-xs mt-1">
              Automatically sets up email, domain, tunnel, and backups.
              Takes about 2 minutes.
            </p>
          </div>
        </div>

        <Button
          asChild
          fullWidth
          className="mb-3"
        >
          <a href={CONNECT_URL} target="_blank" rel="noopener noreferrer">
            Get started with Connect
            <ArrowRight className="w-4 h-4 ml-2" />
          </a>
        </Button>

        <div className="mt-4">
          <label className="text-xs text-primary/50 font-mono mb-1.5 block">
            Paste your Connect token here after signing up
          </label>
          <textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Paste your license key here..."
            rows={2}
            className="w-full rounded-large-element border border-accent/20 bg-primary px-4 py-2.5 text-sm text-secondary font-mono focus-visible:outline-none focus-visible:border-accent resize-none"
            disabled={activating}
          />
          {error && (
            <p className="text-xs text-error mt-1.5">{error}</p>
          )}
          <Button
            variant="accent"
            size="sm"
            className="mt-2"
            onClick={handleActivate}
            loading={activating}
            disabled={!token.trim()}
          >
            Activate
          </Button>
        </div>
      </div>

      {/* Option 2: Set up manually */}
      <div className="rounded-large-element border border-accent/10 p-5">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-pill bg-accent/10 flex items-center justify-center">
            <Settings className="w-4 h-4 text-accent/60" />
          </div>
          <div className="flex-1">
            <h2 className="font-mono text-base text-primary/80">
              Set up manually
            </h2>
            <p className="text-primary/50 text-xs mt-1 mb-3">
              Configure each service individually in Settings after setup.
              You can always enable Connect later.
            </p>
            <Button variant="outline" size="sm" onClick={onSkip}>
              Skip for now
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

ExternalServicesStep.propTypes = {
  onActivate: PropTypes.func.isRequired,
  onSkip: PropTypes.func.isRequired,
};
