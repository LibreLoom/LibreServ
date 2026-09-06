import { memo } from "react";
import { CheckCircle, ExternalLink, ArrowLeft } from "lucide-react";
import Button from "../../ui/Button";
import CopyableValue from "../../ui/CopyableValue";
import { ICON_SIZE } from "@/lib/ui-tokens";

function CompleteStep({ app, instance, onDone }) {
  const subdomain = instance?.subdomain;
  const domain = instance?.domain;
  // Prefer the backend-provided public URL (correct http/https scheme) over
  // reconstructing it — the backend sets instance.url via EnsurePublicURL on
  // the install path, so it already reflects https when AutoHTTPS is on.
  const appUrl = instance?.url || instance?.backends?.[0]?.url || "";
  const generatedPassword = instance?.config?.admin_password || instance?.config?._generated_password;

  return (
    <div className="space-y-6" data-slot="complete-step">
      <div className="text-center space-y-4">
        <CheckCircle className="mx-auto text-accent" size={48} />
        <h2 className="font-mono text-2xl font-normal text-secondary">
          Installation Complete!
        </h2>
        <p className="text-accent">
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
              <p className="text-xs text-accent">Your app is accessible on the web</p>
            </div>
          </div>

          <div className="bg-primary/5 rounded-pill px-4 py-3">
            <div className="text-xs font-mono text-accent uppercase tracking-wide mb-2">Access URL</div>
            <div className="font-mono text-xl text-accent break-all">
              {subdomain}.{domain}
            </div>
          </div>
        </div>
      )}

      {generatedPassword && (
        <div className="max-w-md mx-auto p-4 rounded-large-element bg-secondary text-primary border border-primary/20 space-y-3">
          <p className="font-mono text-sm">
            Your temporary password:
          </p>
          <CopyableValue
            value={generatedPassword}
            copyLabel="Copy password"
            ariaLabel="Temporary password"
          />
          <p className="text-xs text-primary">
            Save this password. You&apos;ll need it to log in.
          </p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row justify-center gap-3 pt-4">
        {appUrl && (
          <Button asChild variant="secondary" surface="primary" className="px-6 font-mono">
            <a href={appUrl} target="_blank" rel="noopener noreferrer">
              Open App
              <ExternalLink size={ICON_SIZE.md} />
            </a>
          </Button>
        )}
        <Button
          variant="outline"
          surface="primary"
          onClick={onDone}
          className="px-6"
        >
          <ArrowLeft size={ICON_SIZE.md} />
          Back to Apps
        </Button>
      </div>
    </div>
  );
}

export default memo(CompleteStep);
