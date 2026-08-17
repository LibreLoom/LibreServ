import { useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Plug, PlugZap, ExternalLink, LogOut, CircleHelp } from "lucide-react";
import Card from "../cards/Card.jsx";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button";
import Callout from "../common/Callout";

const PLAN_BADGES = {
  free: { label: "Connect Free", class: "bg-accent/10 text-accent" },
  one: { label: "Connect One", class: "bg-accent text-primary" },
  lite: { label: "Connect Lite", class: "bg-accent text-primary" },
};

export default function ConnectStatusCard({
  connected,
  plan = null,
  connectKeyHint = null,
  services,
  onActivate,
  onDeactivate,
  onOpenPlanPage,
  loading = false,
  noPopIn = false,
}) {
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [connectKey, setConnectKey] = useState("");
  const [error, setError] = useState(null);

  const planBadge = plan ? PLAN_BADGES[plan.id] : null;

  const connectedCount = services
    ? Object.values(services).filter((s) => s.state === "connected").length
    : 0;
  const totalCount = services ? Object.keys(services).length : 0;

  if (!connected) {
    return (
      <>
        <Card icon={Plug} title="LibreServ Connect" noHeightAnim noPopIn={noPopIn} data-slot="connect-status-card">
          <div className="p-5 space-y-4">
          <p className="text-sm text-accent">
            LibreServ Connect handles the external services your server needs —
            email, a domain name, backups, and more. Everything in one place.
          </p>
          <Button onClick={() => setShowTokenInput(true)}>
            Add Connect
          </Button>
          <p className="text-xs text-accent">
            Don't have an account?{" "}
            <button
              onClick={onOpenPlanPage}
              className="link-accent-card"
            >
              Create one at connect.serv.libreloom.org
            </button>
          </p>
        </div>
      </Card>

      {showTokenInput && (
        <ModalCard title="Enter Your Connect Key" onClose={() => setShowTokenInput(false)} size="md">
          {({close}) => (
          <div className="space-y-4">
            <p className="text-sm text-accent">
              Go to{" "}
              <button
                onClick={onOpenPlanPage}
                className="link-accent-card"
              >
                connect.serv.libreloom.org
              </button>{" "}
              to create an account and get your Connect key. Paste it here.
            </p>
            <input
              type="text"
              value={connectKey}
              onChange={(e) => setConnectKey(e.target.value)}
              placeholder="Paste your Connect key here"
              className="w-full px-4 py-3 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors"
            />
            {error && (
              <Callout tone="error" rounded="large-element">
                <span className="block">{error}</span>
                <Link
                  to="/troubleshoot?issue=connect-key"
                  className="mt-2 inline-flex items-center gap-1 text-xs whitespace-nowrap font-medium text-error hover:text-primary underline decoration-1 underline-offset-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 no-focus-outline rounded-pill motion-safe:transition-colors"
                >
                  <CircleHelp size={14} aria-hidden="true" />
                  Get help fixing this
                </Link>
              </Callout>
            )}
            <div className="flex gap-2 pt-2">
              <Button
                onClick={async () => {
                  if (!onActivate) return;
                  setError(null);
                  try {
                    await onActivate(connectKey);
                    setConnectKey("");
                    setShowTokenInput(false);
                  } catch (err) {
                    setError(err.message || "That Connect key didn't work. Check that you copied the whole key, then try again.");
                  }
                }}
                disabled={!connectKey.trim() || loading}
                loading={loading}
              >
                {loading ? "Connecting..." : "Connect"}
              </Button>
              <Button variant="outline" onClick={close}>
                Back
              </Button>
            </div>
          </div>
          )}
        </ModalCard>
      )}
      </>
    );
  }

  return (
    <Card icon={PlugZap} title="LibreServ Connect" noHeightAnim noPopIn={noPopIn} data-slot="connect-status-card">
      <div className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-accent" />
            <span className="text-sm text-primary font-medium">Connected</span>
          </div>
          {planBadge && (
            <span
              className={cn("text-xs px-3 py-1 rounded-pill font-medium", planBadge.class)}
            >
              {planBadge.label}
            </span>
          )}
        </div>

        {connectKeyHint && (
          <p className="text-xs text-accent/60 font-mono">Key: {connectKeyHint}</p>
        )}

        <p className="text-sm text-accent">
          {connectedCount} of {totalCount} services active
        </p>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="primary" onClick={onOpenPlanPage} smoothResize={false} className="shrink-0 [&_svg]:shrink-0">
            <ExternalLink size={16} /> Manage Plan
          </Button>
          <Button variant="danger" onClick={onDeactivate} smoothResize={false} className="shrink-0 [&_svg]:shrink-0">
            <LogOut size={16} /> Disconnect
          </Button>
        </div>
      </div>
    </Card>
  );
}
