import { cn } from "@/lib/utils";
import { ShieldAlert, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import Card from "../cards/Card";
import Button from "../ui/Button";
import { ICON_SIZE } from "@/lib/ui-tokens";

export default function RevocationBanner({ notice, appName, acknowledged, onSeeDetails }) {
  const [expanded, setExpanded] = useState(false);
  const isMalicious = notice?.severity === "malicious";

  if (acknowledged) {
    const ackDate = notice.acknowledged_at
      ? new Date(notice.acknowledged_at).toLocaleDateString()
      : "previously";
    return (
      <div className="mb-8">
        <Card className={cn("border-2", isMalicious ? "border-error/50 bg-error/5" : "border-warning/50 bg-warning/5")} data-slot="revocation-banner">
          <div className="flex items-center gap-3">
            <AlertTriangle size={ICON_SIZE.lg} className={isMalicious ? "text-error" : "text-warning"} />
            <p className="text-sm text-primary">
              Recalled version (you acknowledged this on {ackDate})
            </p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mb-8">
      <Card className={cn("border-2", isMalicious ? "border-error/50" : "border-warning/50")}>
        <div className={cn("p-4 rounded-large-element", isMalicious ? "bg-error/10" : "bg-warning/10")}>
          <div className="flex items-start gap-3">
            {isMalicious ? (
              <ShieldAlert size={ICON_SIZE.xxl} className="text-error shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle size={ICON_SIZE.xxl} className="text-warning shrink-0 mt-0.5" />
            )}
            <div className="flex-1">
              <h2 className={cn("text-lg font-mono font-normal", isMalicious ? "text-error" : "text-warning")}>
                {isMalicious ? "Security Warning" : "Version Recalled"}
              </h2>
              <p className="text-sm text-primary mt-1">
                {isMalicious
                  ? `This version of ${appName} has been recalled for security reasons.`
                  : "This version has known problems."}
              </p>

              {notice.reason && (
                <p className="text-sm text-primary mt-2 italic">
                  {notice.reason}
                </p>
              )}

              <button
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1 mt-2 text-sm text-accent hover:text-primary transition-colors cursor-pointer"
              >
                {expanded ? <ChevronUp size={ICON_SIZE.sm} /> : <ChevronDown size={ICON_SIZE.sm} />}
                {expanded ? "Less" : "More"} details
              </button>

              {expanded && (
                <div className="mt-3 space-y-2 text-sm text-primary">
                  {isMalicious ? (
                    <p>This version may allow attackers to access your data. We strongly recommend waiting for a fixed version.</p>
                  ) : (
                    <p>This version has known problems. It may not work correctly.</p>
                  )}
                </div>
              )}

              <div className="flex gap-3 mt-4">
                <Button
                  variant="primary"
                  onClick={onSeeDetails}
                >
                  Acknowledge & Continue
                </Button>
                <span className="flex items-center text-sm text-accent">
                  Or wait for a fixed version
                </span>
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
