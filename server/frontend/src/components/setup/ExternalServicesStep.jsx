import { useState } from "react";
import { Globe, Mail, Shield, DatabaseBackup, LifeBuoy, Sparkles, ArrowRight, ArrowLeft, Key, ExternalLink } from "lucide-react";
import PropTypes from "prop-types";
import { cn } from "@/lib/utils";
import Button from "../ui/Button";
import ModalCard from "../cards/ModalCard";

const CONNECT_URL = "https://connect.serv.libreloom.org/onboarding";

const SERVICES = [
  { icon: Globe, label: "Domain", desc: "Reach your apps by name instead of a number" },
  { icon: Mail, label: "Email", desc: "Notifications and password resets" },
  { icon: Shield, label: "Remote access", desc: "Use LibreServ away from home" },
  { icon: DatabaseBackup, label: "Backup", desc: "Protect your data in the cloud" },
  { icon: Sparkles, label: "AI support", desc: "A built-in assistant that answers questions and fixes things for you in real time" },
  { icon: LifeBuoy, label: "Human support", desc: "Talk to a real person at LibreLoom when you're stuck" },
];

/**
 * ExternalServicesStep — rendered inside SetupPage's card shell.
 * Card surface is bg-secondary text-primary. All muted text uses text-accent.
 *
 * Two paths:
 * 1. "Use LibreServ Connect" — immediately opens Connect onboarding in a new
 *    tab, then shows a focused paste-your-key view. If the popup was blocked,
 *    a fallback link is shown.
 * 2. "Set up on your own" — skips to MFA. The user configures each service
 *    individually later in Settings → External Services.
 */
export default function ExternalServicesStep({ onActivate, onSkip }) {
  const [mode, setMode] = useState(null); // null | "connect"
  const [connectKey, setConnectKey] = useState("");
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState("");
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [showDiyConfirm, setShowDiyConfirm] = useState(false);

  const handleActivate = async () => {
    if (!connectKey.trim()) {
      setError("Please paste your Connect key.");
      return;
    }
    setActivating(true);
    setError("");
    try {
      await onActivate(connectKey.trim());
    } catch (err) {
      setError(err.message || "Could not connect to LibreServ Connect. Check your key and try again.");
      setActivating(false);
    }
  };

  const handleChooseConnect = () => {
    // Try to open Connect in a new tab immediately
    const win = window.open(CONNECT_URL, "_blank", "noopener,noreferrer");
    if (!win) {
      setPopupBlocked(true);
    }
    setMode("connect");
  };

  // Landing view — explain the concept and offer two paths
  if (mode === null) {
    return (
      <>
      <div className="flex flex-col items-center text-center py-4" data-slot="external-services">
        <Globe size={48} className="text-accent mx-auto mb-4" />
        <h1 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3">
          Connect to the outside world
        </h1>
        <p className="text-accent text-sm leading-relaxed max-w-md mb-2">
          LibreServ works on its own. But a few external services make it
          much more useful — and harder to accidentally lock yourself out.
        </p>

        <div className="w-full max-w-sm space-y-2 mb-8">
          {SERVICES.map(({ icon: Icon, label, desc }) => (
            <div key={label} className="flex items-start gap-3 text-left">
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-accent/10 flex items-center justify-center mt-0.5">
                <Icon size={14} className="text-accent" />
              </div>
              <div>
                <span className="font-mono text-sm text-primary">{label}</span>
                <p className="text-xs text-accent mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="w-full max-w-sm space-y-2.5">
          <button
            type="button"
            onClick={handleChooseConnect}
            className={cn(
              "w-full flex items-center gap-4 p-4 rounded-large-element border",
              "border-accent/30 bg-accent/10 hover:bg-accent/20 hover:border-accent/40",
              "text-primary motion-safe:transition-all motion-safe:duration-200",
            )}
          >
            <div className="flex-shrink-0 w-9 h-9 rounded-full bg-accent/20 flex items-center justify-center">
              <ExternalLink size={18} className="text-accent" />
            </div>
            <div className="flex-1 text-left">
              <div className="font-mono text-sm text-primary">Use LibreServ Connect</div>
              <div className="text-xs text-accent mt-0.5">
                One signup handles all six services. Free plan available.
              </div>
            </div>
            <ArrowRight size={16} className="text-accent flex-shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => setShowDiyConfirm(true)}
            className={cn(
              "w-full flex items-center gap-4 p-4 rounded-large-element border",
              "border-accent/15 hover:border-accent/30",
              "text-primary motion-safe:transition-all motion-safe:duration-200",
            )}
          >
            <div className="flex-shrink-0 w-9 h-9 rounded-full bg-accent/10 flex items-center justify-center">
              <ArrowRight size={18} className="text-accent" />
            </div>
            <div className="flex-1 text-left">
              <div className="font-mono text-sm text-primary">Set up on your own</div>
              <div className="text-xs text-accent mt-0.5">
                Configure each service individually later. You can always switch to Connect.
              </div>
            </div>
          </button>
        </div>
      </div>

      {showDiyConfirm && (
        <ModalCard
          title="Set up on your own?"
          onClose={() => setShowDiyConfirm(false)}
          footer={({ close }) => (
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={close}>
                Go back
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                onClick={() => { close(); onSkip(); }}
              >
                Yes, set up on my own
              </Button>
            </div>
          )}
        >
          <p className="text-sm text-primary/80">
            No problem. You&rsquo;ll set up each service yourself later in Settings. You can switch to Connect at any time.
          </p>
        </ModalCard>
      )}
      </>
    );
  }

  return (
    <div className="flex flex-col items-center text-center py-4" data-slot="external-services-connect">
      <Key size={48} className="text-accent mx-auto mb-4" />
      <h1 className="font-mono text-3xl font-normal text-primary tracking-tight mb-3">
        Paste your Connect key
      </h1>
      <p className="text-accent text-sm leading-relaxed max-w-md mb-6">
        We've opened the Connect setup in a new tab. Complete the signup there,
        then copy the Connect key from the final step and paste it below.
      </p>

      {popupBlocked && (
        <div className="w-full max-w-sm mb-6 rounded-large-element border border-accent/30 bg-accent/10 p-4 text-left">
          <p className="text-sm text-primary font-mono mb-2">
            Link didn't open?
          </p>
          <p className="text-xs text-accent mb-3">
            If the new tab didn't open automatically, open it manually:
          </p>
          <Button asChild fullWidth size="sm" variant="outline">
            <a href={CONNECT_URL} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="w-4 h-4 mr-2" />
              connect.serv.libreloom.org
            </a>
          </Button>
        </div>
      )}

      <div className="w-full max-w-sm space-y-3">
        <input
          type="text"
          value={connectKey}
          onChange={(e) => setConnectKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleActivate();
            }
          }}
          placeholder="Paste your Connect key here..."
          autoFocus
          disabled={activating}
          className={cn(
            "w-full px-4 py-3 rounded-pill font-mono text-sm",
            "bg-primary text-secondary border-2 border-accent/30",
            "focus:border-accent focus:outline-none",
            "motion-safe:transition-colors placeholder:text-secondary/40",
          )}
        />
        {error && (
          <p className="text-xs text-error">{error}</p>
        )}
        <Button
          variant="accent"
          fullWidth
          onClick={handleActivate}
          loading={activating}
          disabled={!connectKey.trim()}
        >
          <Key className="w-4 h-4 mr-2" />
          Activate Connect
        </Button>
      </div>

      <button
        type="button"
        onClick={() => { setMode(null); setError(""); setPopupBlocked(false); }}
        className="flex items-center gap-1.5 text-sm text-accent hover:text-primary mt-6 motion-safe:transition-colors"
      >
        <ArrowLeft size={14} /> Back
      </button>
    </div>
  );
}

ExternalServicesStep.propTypes = {
  onActivate: PropTypes.func.isRequired,
  onSkip: PropTypes.func.isRequired,
};
