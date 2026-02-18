import { memo } from "react";
import { CheckCircle, ExternalLink, ArrowLeft, Copy, Check } from "lucide-react";
import { useState } from "react";

function CompleteStep({ app, instance, onDone }) {
  const [copied, setCopied] = useState(false);

  const appUrl = instance?.url || instance?.backends?.[0]?.url || "";
  const generatedPassword = instance?.config?.admin_password || instance?.config?._generated_password;

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="text-center space-y-4">
        <CheckCircle className="mx-auto text-accent" size={48} />
        <h2 className="font-mono text-2xl font-normal text-secondary">
          Installation Complete!
        </h2>
        <p className="text-secondary/70">
          {app?.name || "Your app"} is ready to use.
        </p>
      </div>

      {generatedPassword && (
        <div className="max-w-md mx-auto p-4 rounded-large-element bg-secondary/10 border border-secondary/30">
          <p className="font-mono text-sm text-secondary mb-2">
            Your temporary password:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-primary rounded-large-element font-mono text-sm text-accent">
              {generatedPassword}
            </code>
            <button
              onClick={() => handleCopy(generatedPassword)}
              className="p-2 rounded-large-element hover:bg-secondary/20 motion-safe:transition-all"
              aria-label="Copy password"
            >
              {copied ? <Check size={18} className="text-accent" /> : <Copy size={18} />}
            </button>
          </div>
          <p className="text-xs text-secondary/50 mt-2">
            Save this password. You'll need it to log in.
          </p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row justify-center gap-3 pt-4">
        {appUrl && (
          <a
            href={appUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 px-6 py-2 rounded-pill bg-accent text-primary hover:bg-accent/90 motion-safe:transition-all font-mono"
          >
            Open App
            <ExternalLink size={16} />
          </a>
        )}
        <button
          onClick={onDone}
          className="inline-flex items-center justify-center gap-2 px-6 py-2 rounded-pill border-2 border-secondary/30 text-secondary hover:bg-secondary/10 motion-safe:transition-all font-mono"
        >
          <ArrowLeft size={16} />
          Back to Apps
        </button>
      </div>
    </div>
  );
}

export default memo(CompleteStep);
