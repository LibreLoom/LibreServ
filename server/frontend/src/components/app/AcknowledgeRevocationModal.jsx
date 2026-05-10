import { useState, useCallback } from "react";
import { ShieldAlert, AlertTriangle, Loader2 } from "lucide-react";
import { useAuth } from "../../hooks/useAuth";
import ModalCard from "../cards/ModalCard";

export default function AcknowledgeRevocationModal({ app, onClose, onAcknowledged }) {
  const { request } = useAuth();
  const [step, setStep] = useState(1);
  const [typedText, setTypedText] = useState("");
  const [acknowledging, setAcknowledging] = useState(false);
  const [error, setError] = useState(null);

  const notice = app?.revocation_notice;
  const isMalicious = notice?.severity === "malicious";
  const matchesInput = typedText === "I understand";

  const handleAcknowledge = useCallback(async () => {
    if (!app?.id || acknowledging) return;
    setAcknowledging(true);
    setError(null);
    try {
      const csrfRes = await request("/auth/csrf");
      const csrfData = await csrfRes.json();
      const res = await request(`/apps/${app.id}/acknowledge-revocation`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrfData.csrf_token },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to acknowledge revocation");
      }
      onAcknowledged?.();
      onClose?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setAcknowledging(false);
    }
  }, [app, acknowledging, request, onAcknowledged, onClose]);

  return (
    <ModalCard
      title={isMalicious ? "Security Warning" : "Version Recalled"}
      onClose={onClose}
      size="md"
    >
      <div className="space-y-4">
        {step === 1 && (
          <>
            <div className={`flex items-start gap-3 p-3 rounded-large-element border ${isMalicious ? "bg-error/10 border-error/30" : "bg-warning/10 border-warning/30"}`}>
              {isMalicious ? (
                <ShieldAlert size={20} className="text-error shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
              )}
              <div>
                <p className="text-sm text-primary font-medium">
                  This version has been recalled
                </p>
                {notice?.reason && (
                  <p className="text-sm text-primary/70 mt-1">
                    {notice.reason}
                  </p>
                )}
              </div>
            </div>

            <p className="text-sm text-primary/70">
              Running this app could be unsafe.
            </p>

            <div className="flex gap-3 pt-2">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 rounded-pill border-2 border-primary/30 text-primary hover:bg-primary/5 transition-colors disabled:opacity-50"
              >
                Wait for Fixed Version
              </button>
              <button
                onClick={() => setStep(2)}
                className="flex-1 px-4 py-2 rounded-pill bg-accent text-primary hover:bg-accent/80 transition-colors disabled:opacity-50"
              >
                I Understand the Risk
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="p-3 rounded-large-element bg-primary/5 border border-primary/20">
              <p className="text-sm text-primary/80">
                {isMalicious
                  ? "This version may allow attackers to access your data. We strongly recommend waiting for a fixed version."
                  : "This version has known problems. It may not work correctly."}
              </p>
            </div>

            <div>
              <label className="text-sm text-primary/70 block mb-2">
                Type <strong className="text-primary">I understand</strong> to enable the Continue button:
              </label>
              <input
                type="text"
                value={typedText}
                onChange={(e) => setTypedText(e.target.value)}
                placeholder='Type "I understand"'
                className="w-full px-4 py-2 border-2 rounded-pill bg-primary text-secondary placeholder:text-secondary/60 focus:ring-2 focus:ring-accent focus:ring-offset-2 border-primary/30 focus:border-accent"
                disabled={acknowledging}
                autoFocus
              />
            </div>

            {error && (
              <p className="text-sm text-error">{error}</p>
            )}

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => { setStep(1); setTypedText(""); }}
                disabled={acknowledging}
                className="flex-1 px-4 py-2 rounded-pill border-2 border-primary/30 text-primary hover:bg-primary/5 transition-colors disabled:opacity-50"
              >
                Back
              </button>
              <button
                onClick={handleAcknowledge}
                disabled={!matchesInput || acknowledging}
                className="flex-1 px-4 py-2 rounded-pill bg-accent text-primary hover:bg-accent/80 motion-safe:transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {acknowledging ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Acknowledging...
                  </>
                ) : (
                  "Continue"
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </ModalCard>
  );
}
