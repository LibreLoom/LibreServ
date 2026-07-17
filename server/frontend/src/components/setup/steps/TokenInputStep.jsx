import { useState } from "react";
import PropTypes from "prop-types";
import { Eye, EyeOff, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import CollapsibleSection from "../../common/CollapsibleSection";
import Callout from "../../common/Callout";
import Button from "../../ui/Button";

const inputClass = "w-full px-5 py-3.5 rounded-pill border border-primary/20 bg-transparent text-primary placeholder:text-primary/50 font-mono text-sm focus:outline-none focus:border-primary/50 motion-safe:transition-colors motion-safe:duration-150";

const GUIDE_STEPS = [
  "Go to dash.cloudflare.com, then My Profile, then API Tokens",
  "Click \"Create Token\"",
  "Select the \"Edit zone DNS\" template",
  "Under Zone Resources, pick your domain",
  "Click \"Continue to summary\", then \"Create Token\"",
  "Copy the token and paste it above",
];

/** @param {{ token: any, onTokenChange: any, email: any, onEmailChange: any, error: any, onEnter: any, loading?: any, onTest?: any, onBack?: any }} _ */
export default function TokenInputStep({ token, onTokenChange, email, onEmailChange, error, onEnter }) {
  const [showToken, setShowToken] = useState(false);

  return (
    <div data-slot="token-input">
      <h2 className="font-mono text-3xl font-normal text-primary tracking-tight mb-2">
        Connect your Cloudflare account
      </h2>
      <p className="text-primary/50 text-sm mb-6">
        We need an access key from your Cloudflare account to set up your domain. This is a special key that lets LibreServ manage your domain settings &mdash; you can create one using the guide below.
      </p>

      <div className="space-y-4 mb-5">
        <div>
          <label htmlFor="wiz-token" className="block text-sm text-primary/60 translate-x-5 mb-1">
            Access Key <span className="text-error" aria-hidden="true">*</span>
          </label>
          <div className="relative">
            <input
              id="wiz-token"
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => onTokenChange(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onEnter?.()}
              placeholder="v4Yx..."
              className={cn(inputClass, "pr-12")}
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
            Email for secure connection updates <span className="text-error" aria-hidden="true">*</span>
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
            We'll use this email to let you know when your secure connection (HTTPS) is about to expire, so your apps stay accessible.
          </p>
        </div>
      </div>

      <CollapsibleSection title="How to create an access key" size="xs" pill>
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
            <Button asChild variant="outline" surface="secondary" size="sm" className="font-mono text-xs">
              <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer">
                <ExternalLink size={12} />
                Open Dashboard
              </a>
            </Button>
            <Button asChild variant="outline" surface="secondary" size="sm" className="font-mono text-xs">
              <a href="https://developers.cloudflare.com/fundamentals/api/get-started/create-token/" target="_blank" rel="noopener noreferrer">
                <ExternalLink size={12} />
                Open Documentation
              </a>
            </Button>
          </div>
        </div>
      </CollapsibleSection>

      {error && (
        <div className="mt-4 animate-in fade-in slide-in-from-bottom-1 duration-200">
          <Callout tone="error">{error}</Callout>
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
