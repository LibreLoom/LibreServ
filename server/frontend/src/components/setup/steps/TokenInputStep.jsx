import { useState } from "react";
import PropTypes from "prop-types";
import { Eye, EyeOff, ExternalLink, AlertCircle } from "lucide-react";
import CollapsibleSection from "../../common/CollapsibleSection";

const inputClass = "w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/25 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150";

const GUIDE_STEPS = [
  "Go to dash.cloudflare.com, then My Profile, then API Tokens",
  "Click \"Create Token\"",
  "Select the \"Edit zone DNS\" template",
  "Under Zone Resources, pick your domain",
  "Click \"Continue to summary\", then \"Create Token\"",
  "Copy the token and paste it above",
];

export default function TokenInputStep({ token, onTokenChange, email, onEmailChange, error, onEnter }) {
  const [showToken, setShowToken] = useState(false);

  return (
    <div>
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        Connect your Cloudflare account
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        We need an API token from your Cloudflare account to set up your domain. This is a special key that lets LibreServ manage your domain settings &mdash; you can create one below.
      </p>

      <div className="space-y-4 mb-5">
        <div>
          <label htmlFor="wiz-token" className="block text-sm text-primary/60 translate-x-5 mb-1">
            API Token <span className="text-error" aria-hidden="true">*</span>
          </label>
          <div className="relative">
            <input
              id="wiz-token"
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => onTokenChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
              placeholder="v4Yx..."
              className={`${inputClass} pr-12`}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-primary/30 hover:text-primary/60 motion-safe:transition-colors motion-safe:duration-150"
              aria-label={showToken ? "Hide token" : "Show token"}
            >
              {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="wiz-email" className="block text-sm text-primary/60 translate-x-5 mb-1">
            Email for certificate updates <span className="text-error" aria-hidden="true">*</span>
          </label>
          <input
            id="wiz-email"
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
            placeholder="admin@example.com"
            className={inputClass}
            autoComplete="email"
          />
          <p className="text-xs text-primary/35 mt-1.5 translate-x-5">
            Used by our certificate provider for expiry notices.
          </p>
        </div>
      </div>

      <CollapsibleSection title="How to create an API token" size="xs" pill>
        <div className="space-y-3">
          {GUIDE_STEPS.map((step, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-accent/15 text-accent font-mono text-[10px] flex items-center justify-center mt-0.5">
                {i + 1}
              </span>
              <p className="text-xs text-primary/60 leading-relaxed">{step}</p>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-2">
            <a
              href="https://dash.cloudflare.com/profile/api-tokens"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-pill border border-primary/15 bg-primary/5 text-primary px-3.5 py-2 font-mono text-xs motion-safe:transition-all motion-safe:duration-200 hover:bg-primary/10 hover:border-primary/25"
            >
              <ExternalLink size={12} />
              Open Dashboard
            </a>
            <a
              href="https://developers.cloudflare.com/fundamentals/api/get-started/create-token/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-pill border border-primary/10 text-primary/50 px-3.5 py-2 font-mono text-xs motion-safe:transition-all motion-safe:duration-200 hover:text-primary/70 hover:border-primary/20"
            >
              <ExternalLink size={12} />
              Open Documentation
            </a>
          </div>
        </div>
      </CollapsibleSection>

      {error && (
        <div className="flex items-start gap-2.5 p-4 rounded-card border border-error/25 bg-error/10 mt-4 animate-in fade-in slide-in-from-bottom-1 duration-200">
          <AlertCircle className="w-4 h-4 text-error flex-shrink-0 mt-0.5" />
          <p className="text-sm text-primary/80">{error}</p>
        </div>
      )}
    </div>
  );
}

TokenInputStep.propTypes = {
  token:         PropTypes.string.isRequired,
  onTokenChange: PropTypes.func.isRequired,
  email:         PropTypes.string.isRequired,
  onEmailChange: PropTypes.func.isRequired,
  error:         PropTypes.string,
  onEnter:       PropTypes.func,
};
