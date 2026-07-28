import { useState } from "react";
import { cn } from "@/lib/utils";
import { Plug, PlugZap, ExternalLink, LogOut } from "lucide-react";
import Card from "../cards/Card.jsx";
import ModalCard from "../cards/ModalCard.jsx";
import Button from "../ui/Button";
import Alert from "../common/Alert";

const PLAN_BADGES = {
  free: { label: "Connect Free", class: "bg-accent/10 text-accent" },
  one: { label: "Connect One", class: "bg-accent text-primary" },
  lite: { label: "Connect Lite", class: "bg-accent text-primary" },
};

export default function ConnectStatusCard({
  connected,
  plan = null,
  tokenHint = null,
  services,
  onActivate,
  onDeactivate,
  onOpenPlanPage,
  loading = false,
  noPopIn = false,
}) {
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [token, setToken] = useState("");
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
        <ModalCard title="Enter Your Connect Token" onClose={() => setShowTokenInput(false)} size="md">
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
              to create an account and get your Connect token. Paste it here.
            </p>
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your Connect token here"
              className="w-full px-4 py-3 rounded-pill bg-primary text-secondary border-2 border-secondary/20 focus:border-accent focus:outline-none motion-safe:transition-colors"
            />
            {error && <Alert variant="error" message={error} />}
            <div className="flex gap-2 pt-2">
              <Button
                onClick={async () => {
                  if (!onActivate) return;
                  setError(null);
                  try {
                    await onActivate(token);
                    setToken("");
                    setShowTokenInput(false);
                  } catch (err) {
                    setError(err.message || "Could not connect to LibreServ Connect. Please check your token and try again.");
                  }
                }}
                disabled={!token.trim() || loading}
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

        {tokenHint && (
          <p className="text-xs text-accent/60 font-mono">Token: {tokenHint}</p>
        )}

        <p className="text-sm text-accent">
          {connectedCount} of {totalCount} services active
        </p>

        <div className="flex gap-2">
          <Button variant="primary" onClick={onOpenPlanPage}>
            <ExternalLink size={16} /> Manage Plan
          </Button>
          <Button variant="danger" onClick={onDeactivate}>
            <LogOut size={16} /> Disconnect
          </Button>
        </div>
      </div>
    </Card>
  );
}
