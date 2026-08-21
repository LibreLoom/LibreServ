import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, KeyRound, ShieldOff, Unplug } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import Pill from "../components/common/Pill";
import PageNotice from "../components/common/PageNotice";
import { getJson, postJson, apiErrorMessage } from "../lib/api";

export default function RemotePage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const status = useQuery({ queryKey: ["connect-status"], queryFn: () => getJson("/api/v1/connect/status") });

  const activate = useMutation({
    mutationFn: () => postJson("/api/v1/connect/activate-free", {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connect-status"] }); setError(null); },
    onError: (err) => setError(apiErrorMessage(err, "Luna couldn't turn remote access on. Check that this Luna can reach the internet.")),
  });
  const enable = useMutation({
    mutationFn: () => postJson("/api/v1/connect/tunnel/enable", {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connect-status"] }); setError(null); },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const off = useMutation({
    mutationFn: () => postJson("/api/v1/connect/deactivate", {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connect-status"] }); setError(null); },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const s = status.data || { enabled: false };
  const address = s.domain ? (s.domain.includes("://") ? s.domain : `https://${s.domain}`) : "";

  return (
    <Page title="Remote access" titleId="remote-title"
      bottomContent={<p className="text-sm">Remote access is off until you turn it on. It&apos;s free forever.</p>}
    >
      {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
      <div className="grid gap-5 md:grid-cols-2">
        <Card icon={Globe2} title="Luna Connect" headerActions={s.enabled ? <Pill variant="success">On</Pill> : <Pill variant="warning">Off</Pill>}>
          {s.enabled ? (
            <div className="space-y-3">
              <p className="text-primary text-sm">
                Your Luna is reachable anywhere at{" "}
                <span className="font-mono">{s.domain || "your Luna address"}</span>.
                Open that address on a phone or computer the same way you open Luna at home, then sign in.
              </p>
              {address && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(address);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  {copied ? "Copied" : "Copy address"}
                </Button>
              )}
              {!s.tunnel_active && (
                <>
                  <p className="text-primary text-sm">
                    The address is ready, but the tunnel is off. Phones away from home cannot reach Luna until you turn the tunnel on.
                  </p>
                  <Button variant="primary" loading={enable.isPending} onClick={() => enable.mutate()}>Turn tunnel on</Button>
                </>
              )}
              <Button variant="danger" loading={off.isPending} onClick={() => off.mutate()}>Turn Luna Connect off</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-primary text-sm">
                One tap. Luna gets its own free key — no account, no checkout,
                no router changes, no ports. Free forever.
              </p>
              <Button variant="primary" fullWidth loading={activate.isPending} onClick={() => activate.mutate()}>
                Turn Luna Connect on
              </Button>
            </div>
          )}
        </Card>

        <Card icon={ShieldOff} title="Your own way">
          <p className="text-primary text-sm">
            Skip the free Luna address if you already run a private network. These steps are for someone who already knows the tool.
          </p>
          <ul className="mt-3 space-y-3 text-sm text-primary">
            <li className="flex items-start gap-2">
              <Unplug size={14} className="text-accent mt-1 shrink-0" />
              <span>
                Tailscale or WireGuard: install the app on Luna&apos;s computer (or the device that shares this network), then on your phone. Open Luna at its private address from that app — often luna.local still works once both devices are on the same private network.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <KeyRound size={14} className="text-accent mt-1 shrink-0" />
              <span>
                Port forwarding: in your internet box, send web traffic (ports 80 and 443) to Luna. Then open Luna at your home&apos;s public number. Your browser may warn about the certificate — that is expected for a numbered address.
              </span>
            </li>
          </ul>
          <p className="text-primary text-sm mt-3">Luna Connect is the easy path if you are not sure.</p>
        </Card>
      </div>
    </Page>
  );
}
