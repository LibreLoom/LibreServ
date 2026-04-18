import { useState, useCallback } from "react";
import PropTypes from "prop-types";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import { Globe, AlertTriangle, Loader2, ArrowUpRight, ShieldAlert, ExternalLink } from "lucide-react";
import SettingsCard from "../SettingsCard";
import Button from "../../ui/Button";
import ConfirmModal from "../../common/ConfirmModal";

export default function DomainManagementCard({ currentDomain, onDomainChange, onChangeDomain }) {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await request("/network/domain/disconnect", {
        method: "POST",
      });
      
      if (res.ok) {
        addToast({
          type: "warning",
          message: "Domain disconnected",
          description: "All routes have been cleared. You can reconnect a domain anytime.",
        });
        onDomainChange("");
        setShowDisconnectModal(false);
      } else {
        const data = await res.json();
        addToast({ type: "error", message: data.error || "Failed to disconnect domain" });
      }
    } catch (err) {
      addToast({ type: "error", message: err.message });
    } finally {
      setDisconnecting(false);
    }
  }, [request, addToast, onDomainChange]);

  const isLocalhost = !currentDomain || currentDomain === "localhost" || currentDomain === "127.0.0.1";

  if (!currentDomain || isLocalhost) {
    return (
      <SettingsCard icon={Globe} title="Domain Connection" index={1}>
        <div className="px-5 py-4 flex justify-center">
          <div className="w-full max-w-sm rounded-large-element border border-primary/10 bg-secondary overflow-hidden">
            <div className="px-8 py-12 flex flex-col items-center text-center">
              <div className="inline-flex items-center gap-4 px-8 py-4 rounded-pill bg-accent/15 text-accent mb-8 border border-accent/20">
                <Globe size={28} />
                <span className="font-mono text-lg tracking-wide">Local Access Only</span>
              </div>
              <p className="text-sm text-primary/60 max-w-xs mb-8 leading-relaxed">
                Your server is only accessible via localhost. Connect a domain to enable HTTPS and remote access.
              </p>
              <Button
                variant="primary"
                onClick={onChangeDomain}
                className="w-full"
              >
                <ExternalLink size={16} />
                Connect Domain
              </Button>
            </div>
          </div>
        </div>
      </SettingsCard>
    );
  }

  return (
    <>
      <SettingsCard icon={Globe} title="Connected Domain" index={1}>
        <div className="px-5 py-4">
          <div className="rounded-large-element border border-primary/10 bg-secondary overflow-hidden">
            <div className="px-4 py-3.5 space-y-4">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-primary/60 font-mono">Current Domain</span>
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill bg-accent/20 text-accent text-xs font-mono">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                    Active
                  </div>
                </div>
                
                <div className="inline-flex items-center gap-3 px-4 py-2.5 rounded-pill bg-primary/15 border border-primary/20 font-mono text-sm">
                  <Globe size={16} className="text-accent" />
                  <span className="text-primary">{currentDomain}</span>
                  <a
                    href={`https://${currentDomain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-pill bg-primary/10 text-primary/70 hover:text-accent hover:bg-primary/20 transition-all"
                    title="Open in new tab"
                  >
                    <ArrowUpRight size={12} />
                  </a>
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <Button
                  variant="accent"
                  className="flex-1"
                  onClick={onChangeDomain}
                >
                  Change Domain
                </Button>
                <Button
                  variant="danger"
                  className="flex-1"
                  onClick={() => setShowDisconnectModal(true)}
                >
                  Disconnect
                </Button>
              </div>

              <div className="flex items-start gap-2 px-3 py-2.5 rounded-pill bg-warning/10 border border-warning/20">
                <ShieldAlert size={16} className="text-warning mt-0.5 flex-shrink-0" />
                <div className="text-xs text-warning leading-relaxed">
                  <strong className="font-mono">Warning:</strong> Disconnecting removes all DNS records and clears app routes. Apps remain accessible via localhost only.
                </div>
              </div>
            </div>
          </div>
        </div>
      </SettingsCard>

      <ConfirmModal
        open={showDisconnectModal}
        onClose={() => setShowDisconnectModal(false)}
        onConfirm={handleDisconnect}
        icon={AlertTriangle}
        title="Disconnect Domain"
        message={`Disconnect ${currentDomain}? This will:
          • Remove all DNS records
          • Clear all app routes
          • Apps will only be accessible via localhost`}
        variant="danger"
        confirmLabel="Disconnect"
        loading={disconnecting}
      />
    </>
  );
}
