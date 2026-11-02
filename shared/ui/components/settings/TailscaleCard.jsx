import { useState } from "react";
import { Globe2, ShieldCheck } from "lucide-react";
import ConfirmModal from "../cards/ConfirmModal.jsx";
import Button from "../ui/Button.jsx";
import CopyableValue from "../ui/CopyableValue.jsx";
import InlinePill from "../common/InlinePill.jsx";
import PageNotice from "../common/PageNotice.jsx";
import SegmentedControl from "../common/SegmentedControl.jsx";
import SettingsCard from "./SettingsCard.jsx";
import { InfoHint } from "../ui/Tooltip.jsx";
/**
 * Shared settings view. Each product supplies its authenticated API adapter.
 * @param {{product: "Luna"|"Sol", status?: any, loading?: boolean, busy?: boolean, error?: string, onAction: (action: string, body?: object) => void}} props
 */
export default function TailscaleCard({
  product,
  status: s = {},
  loading = false,
  busy = false,
  error = "",
  onAction: run,
}) {
  const [confirmPublic, setConfirmPublic] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [serverKind, setServerKind] = useState(null);
  const [serverDraft, setServerDraft] = useState(null);
  const selectedKind = s.identity_saved || s.enabled ? (s.control_server ? "headscale" : "tailscale") : serverKind ?? (s.control_server ? "headscale" : "tailscale");
  const serverAddress = s.identity_saved || s.enabled ? s.control_server || "" : serverDraft ?? s.control_server ?? "";
  const headscale = Boolean(s.control_server);
  const serverLocked = Boolean(s.identity_saved || s.enabled || s.residual_exposure);
  let validServer = selectedKind !== "headscale";
  if (!validServer) {
    try {
      const u = new URL(serverAddress);
      validServer = u.protocol === "https:" && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash;
    } catch { /* an incomplete address is not ready to submit */ }
  }
  const connected = s.state === "connected";
  const statusText = loading
    ? "Checking"
    : {
        connected: "Connected",
        starting: "Connecting",
        pending: "Waiting for approval",
        disconnected: "Disconnected",
        error: "Needs attention",
      }[s.state] || (error ? "Unavailable" : "Off");
  const approvalIsPublic = s.approval_type === "funnel";
  return (
    <>
      <SettingsCard
        icon={Globe2}
        title="Tailscale remote access"
        headerActions={
          <span className="rounded-chip surface-primary px-3 py-1 text-xs">
            {statusText}
          </span>
        }
      >
        <div className="space-y-4 px-4 pb-4">
          <p className="text-primary text-sm">
            Reach {product} away from home without {product} Connect.
          </p>
          {!loading && (
            <div className="space-y-2">
              <p className="text-sm">Control server <InfoHint content="The control server connects your devices to each other. Headscale is a self-hosted alternative to Tailscale's server." /></p>
              <SegmentedControl
                aria-label="Control server"
                surface="secondary"
                value={selectedKind}
                options={[
                  { value: "tailscale", label: "Tailscale", disabled: serverLocked || busy },
                  { value: "headscale", label: "Headscale", disabled: serverLocked || busy },
                ]}
                onChange={setServerKind}
              />
              {selectedKind === "headscale" && (
                <div className="space-y-2">
                  <label htmlFor="headscale-server" className="text-sm">Headscale server address</label>
                  <input id="headscale-server" type="url" value={serverAddress} disabled={serverLocked || busy}
                    onChange={(event) => setServerDraft(event.target.value)} placeholder="https://headscale.example.com"
                    className="w-full rounded-pill surface-primary px-4 py-2 focus:border-accent" />
                  <p className="text-sm">Enter an HTTPS address without a path. Private web access requires a Headscale version that supports Tailscale HTTPS certificates, with DNS-01 certificates configured by its administrator. Public access is unavailable.</p>
                </div>
              )}
              {serverLocked && <p className="text-sm">Sign out of Tailscale to change the control server.</p>}
            </div>
          )}
          {error && <PageNotice variant="error">{error}</PageNotice>}
          {s.error && s.error !== error && <PageNotice variant="error">{s.error}</PageNotice>}
          {s.residual_exposure && <PageNotice variant="error">Public access may still be on. Turn off Tailscale and check again.</PageNotice>}
          {s.state === "pending" && (
            <div className="surface-primary rounded-large-element p-4 space-y-3">
              <p className="text-sm">
                Approve {product} in {headscale ? "Headscale" : "Tailscale"} to finish connecting.
              </p>
              {s.auth_url && (
                <Button variant="secondary" asChild>
                  <a
                    href={s.auth_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Approve {product} in {headscale ? "Headscale" : "Tailscale"}
                  </a>
                </Button>
              )}
            </div>
          )}
          {s.approval_url && (
            <div className="surface-primary rounded-large-element p-4 space-y-3">
              <p className="text-sm">
                {approvalIsPublic
                  ? "Approve public access in Tailscale, then try turning it on again."
                  : "Approve HTTPS in Tailscale, then try turning on private access again."}
              </p>
              <Button variant="secondary" asChild>
                <a
                  href={s.approval_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {approvalIsPublic
                    ? "Approve public access in Tailscale"
                    : "Approve HTTPS in Tailscale"}
                </a>
              </Button>
            </div>
          )}
          {s.private_url && !s.public_url && (
            <p className="text-primary text-sm">
              Install Tailscale on each phone or computer you want to use.
            </p>
          )}
          {s.private_url && !s.public_url && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <ShieldCheck size={16} aria-hidden="true" />
                <span>Private address</span>
                <InfoHint content="Only devices approved for your Tailscale network can open this address." />
              </div>
              <CopyableValue
                value={s.private_url}
                copyLabel="Copy private address"
                ariaLabel="Tailscale private address"
              />
              <Button variant="outline" asChild>
                <a
                  href={s.private_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open private address
                </a>
              </Button>
            </div>
          )}
          {s.public_url && (
            <div className="space-y-2">
              <p className="text-primary text-sm">Public address</p>
              <CopyableValue
                value={s.public_url}
                copyLabel="Copy public address"
                ariaLabel="Tailscale public address"
              />
              <Button variant="outline" asChild>
                <a
                  href={s.public_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open public address
                </a>
              </Button>
            </div>
          )}
          {connected && (
            <p className="text-primary text-sm">
              {product === "Luna"
                ? "Access covers Luna’s web app and files."
                : "Access covers the Sol dashboard. Apps and other network services are not shared."}
              {product === "Sol" && <InfoHint content="Tailscale is managed here and is not included in Sol's Network checks." />}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {connected && s.private_url && !s.public_url && (
              <Button variant="outline" disabled={busy} onClick={() => run("stop-serve")}>
                Turn off private access
              </Button>
            )}
            {s.state === "connected" && !s.private_url && !s.public_url && (
              <Button
                variant="primary"
                loading={busy}
                disabled={busy}
                onClick={() => run("serve", { public: false })}
              >
                Turn on private access
              </Button>
            )}
            {s.state === "connected" && s.private_url && !s.public_url && !headscale && (
              <Button
                variant="outline"
                surface="secondary"
                disabled={busy}
                onClick={() => setConfirmPublic(true)}
              >
                Turn on public access
              </Button>
            )}
            {s.state === "connected" && s.public_url && (
              <Button
                variant="outline"
                surface="secondary"
                disabled={busy}
                onClick={() => run("serve", { public: false })}
              >
                Turn off public access
              </Button>
            )}
            {!loading && s.enabled === false && (
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || s.installed === false || !validServer}
                onClick={() => run("connect", { control_server: selectedKind === "headscale" ? new URL(serverAddress).origin : "" })}
              >
                Connect {product}
              </Button>
            )}
            {s.enabled && !connected && (
              <Button
                variant="primary"
                loading={busy}
                disabled={busy || s.installed === false}
                onClick={() => run("reconnect")}
              >
                Reconnect
              </Button>
            )}
            {(s.enabled || s.residual_exposure) && (
              <Button
                variant="outline"
                surface="secondary"
                loading={busy}
                onClick={() => run("disable")}
              >
                Turn off Tailscale
              </Button>
            )}
            {(s.identity_saved || s.enabled) && (
              <Button
                variant="outline"
                surface="secondary"
                disabled={busy}
                onClick={() => setConfirmForget(true)}
              >
                Sign out of Tailscale
              </Button>
            )}
          </div>
          {s.installed === false && (
            <PageNotice variant="error">
              Tailscale is missing from this {product} installation. Remote access is unavailable.
            </PageNotice>
          )}
        </div>
      </SettingsCard>
      <ConfirmModal
        open={confirmPublic}
        onClose={() => setConfirmPublic(false)}
        onConfirm={() => {
          setConfirmPublic(false);
          run("serve", { public: true, confirm_public: true });
        }}
        title="Turn on public access?"
        confirmLabel="Turn on public access"
        variant="warning"
        loading={busy}
      >
        <p className="text-primary text-sm">
          Anyone on the internet can reach {product}&apos;s sign-in page
          {product === "Luna" ? " and public share links" : ""}. Visitors do not
          need Tailscale. {product}&apos;s sign-in and permissions still apply.
        </p>
        <p className="mt-3 text-primary text-sm">
          Tailscale gives {product} an encrypted web address ending in{" "}
          <InlinePill>ts.net</InlinePill>. Funnel is a beta service with bandwidth limits.
          This makes the address public. Tailscale may ask you
          to approve it.
        </p>
      </ConfirmModal>
      <ConfirmModal
        open={confirmForget}
        onClose={() => setConfirmForget(false)}
        onConfirm={() => {
          setConfirmForget(false);
          run("forget");
        }}
        title={`Remove ${product} from this Tailscale setup?`}
        confirmLabel="Sign out of Tailscale"
        variant="danger"
        loading={busy}
      >
        <p className="text-primary text-sm">
          {product} will disconnect and forget this connection. You may also
          need to remove its old device entry in Tailscale.
        </p>
      </ConfirmModal>
    </>
  );
}
