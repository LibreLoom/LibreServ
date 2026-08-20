import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, KeyRound, ShieldOff, Unplug } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import Pill from "../components/common/Pill";
import { getJson, postJson } from "../lib/api";

export default function RemotePage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const status = useQuery({ queryKey: ["connect-status"], queryFn: () => getJson("/api/v1/connect/status") });

  const activate = useMutation({
    mutationFn: () => postJson("/api/v1/connect/activate-free", {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connect-status"] }),
    onError: (err) => setError(String(err)),
  });
  const enable = useMutation({
    mutationFn: () => postJson("/api/v1/connect/tunnel/enable", {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connect-status"] }),
    onError: (err) => setError(String(err)),
  });
  const off = useMutation({
    mutationFn: () => postJson("/api/v1/connect/deactivate", {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connect-status"] }),
    onError: (err) => setError(String(err)),
  });

  const s = status.data || { enabled: false };

  return (
    <Page title="Remote access" titleId="remote-title"
      bottomContent={<p className="text-sm">Remote access is off until you turn it on. It&apos;s free forever.</p>}
    >
      <div className="grid gap-5 md:grid-cols-2">
        <Card icon={Globe2} title="Luna Connect" headerActions={s.enabled ? <Pill variant="success">On</Pill> : <Pill variant="warning">Off</Pill>}>
          {s.enabled ? (
            <div className="space-y-3">
              <p className="text-primary text-sm">
                Your Luna is reachable anywhere at <span className="font-mono">{s.domain || "your Luna address"}</span>.
              </p>
              {!s.tunnel_active && (
                <Button variant="primary" loading={enable.isPending} onClick={() => enable.mutate()}>Turn tunnel on</Button>
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
          {error && <p className="text-error text-xs mt-2">{error}</p>}
        </Card>

        <Card icon={ShieldOff} title="Your own way">
          <p className="text-primary text-sm">No cloud, no account — use a private network you already run.</p>
          <ul className="mt-3 space-y-2 text-xs text-primary">
            <li className="flex items-center gap-2"><Unplug size={14} className="text-accent" />Install Tailscale or WireGuard and point it at Luna's local address.</li>
            <li className="flex items-center gap-2"><KeyRound size={14} className="text-accent" />Port forwarding: open port 80/443 on your router toward Luna. Your browser may warn about the certificate — that's expected for a bare IP.</li>
          </ul>
          <p className="text-accent text-xs mt-3">These are advanced paths. Luna Connect is the easy one.</p>
        </Card>
      </div>
    </Page>
  );
}
