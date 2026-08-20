import { memo, useState } from "react";
import { CheckCircle, ExternalLink, ArrowLeft, Copy, Check } from "lucide-react";
import { copyWithFeedback } from "../../../utils/clipboard";
import Button from "../../ui/Button";

function CompleteStep({ app, instance, onDone }) {
  const [copied, setCopied] = useState(false);

  const subdomain = instance?.subdomain;
  const domain = instance?.domain;
  // Prefer the backend-provided public URL (correct http/https scheme) over
  // reconstructing it — the backend sets instance.url via EnsurePublicURL on
  // the install path, so it already reflects https when AutoHTTPS is on.
  const appUrl = instance?.url || instance?.backends?.[0]?.url || "";
  const generatedPassword = instance?.config?.admin_password || instance?.config?._generated_password;

  const handleCopy = async (text) => {
    await copyWithFeedback(text, setCopied);
  };

  return (
    <div className="space-y-6" data-slot="complete-step">
      <div className="text-center space-y-4">
        <CheckCircle className="mx-auto text-accent" size={48} />
        <h2 className="font-mono text-2xl font-normal text-secondary">
          Installation Complete!
        </h2>
        <p className="text-secondary/70">
          {app?.name || "Your app"} is ready to use.
        </p>
      </div>

      {subdomain && domain && (
        <div className="max-w-md mx-auto p-5 rounded-large-element bg-secondary/10 border border-secondary/30">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            <div>
              <h3 className="font-mono text-sm font-medium text-secondary">Domain Ready</h3>
              <p className="text-xs text-secondary/70">Your app is accessible on the web</p>
            </div>
          </div>

          <div className="bg-primary/5 rounded-pill px-4 py-3">
            <div className="text-xs font-mono text-secondary/50 uppercase tracking-wide mb-2">Access URL</div>
            <div className="font-mono text-xl text-accent break-all">
              {subdomain}.{domain}
            </div>
          </div>
        </div>
      )}

      {generatedPassword && (
        <div className="max-w-md mx-auto p-4 rounded-large-element bg-secondary/10 border border-secondary/30">
          <p className="font-mono text-sm text-secondary mb-2">
            Your temporary password:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-primary rounded-large-element font-mono text-sm text-secondary">
              {generatedPassword}
            </code>
            <Button
              variant="ghost"
              size="icon"
              surface="primary"
              onClick={() => handleCopy(generatedPassword)}
              aria-label="Copy password"
            >
              {copied ? <Check size={18} className="text-secondary" /> : <Copy size={18} />}
            </Button>
          </div>
          <p className="text-xs text-secondary/70 mt-2">
            Save this password. You'll need it to log in.
          </p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row justify-center gap-3 pt-4">
        {appUrl && (
          <Button asChild variant="secondary" surface="primary" className="px-6 font-mono">
            <a href={appUrl} target="_blank" rel="noopener noreferrer">
              Open App
              <ExternalLink size={16} />
            </a>
          </Button>
        )}
        <Button
          variant="outline"
          surface="primary"
          onClick={onDone}
          className="px-6"
        >
          <ArrowLeft size={16} />
          Back to Apps
        </Button>
      </div>
    </div>
  );
}

export default memo(CompleteStep);
