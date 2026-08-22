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
  const [name, setName] = useState("");
  const [newName, setNewName] = useState("");
  const status = useQuery({ queryKey: ["connect-status"], queryFn: () => getJson("/api/v1/connect/status") });

  const activate = useMutation({
    mutationFn: () => postJson("/api/v1/connect/enable", { subdomain: name.trim().toLowerCase() }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connect-status"] }); setError(null); },
    onError: (err) => setError(apiErrorMessage(err, "Luna couldn't turn remote access on. Check that this Luna can reach the internet.")),
  });
  const change = useMutation({
    mutationFn: () => postJson("/api/v1/connect/domain", { subdomain: newName.trim().toLowerCase() }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connect-status"] }); setError(null); setNewName(""); },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const pair = useMutation({
    mutationFn: () => postJson("/api/v1/connect/pairing-code", {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connect-status"] }); setError(null); },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const off = useMutation({
    mutationFn: () => postJson("/api/v1/connect/deactivate", {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connect-status"] }); setError(null); },
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const s = status.data || { enabled: false };
  const host = s.hostname || s.domain || "";
  const address = host ? (host.includes("://") ? host : `https://${host}`) : "";

  return (
    <Page title="Remote access" titleId="remote-title"
      bottomContent={<p className="text-sm">Remote access is off until you pick a name. The address is free forever.</p>}
    >
      {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
      <div className="grid gap-5 md:grid-cols-2">
        <Card icon={Globe2} title="Luna Connect" headerActions={s.enabled ? <Pill variant="success">On</Pill> : <Pill variant="warning">Off</Pill>}>
          {s.enabled ? (
            <div className="space-y-3">
              <p className="text-primary text-sm">
                Your Luna is reachable anywhere at{" "}
                <span className="font-mono">{host || "your Luna address"}</span>.
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
              <label className="block text-primary text-sm">
                Change address
                <input
                  className="mt-1 w-full rounded-pill bg-primary text-secondary px-4 py-2 font-mono"
                  placeholder="kitchen"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </label>
              <p className="text-primary text-sm font-mono">{newName ? `${newName.toLowerCase()}.luna.servers.libreloom.org` : "name.luna.servers.libreloom.org"}</p>
              <Button variant="primary" loading={change.isPending} disabled={newName.trim().length < 3} onClick={() => change.mutate()}>Save new address</Button>
              <p className="text-primary text-sm">
                To store a spare copy of files in the cloud, add a card at connect.luna.libreserv.org, then pair this Luna.
              </p>
              {s.pairing_code && <p className="font-mono text-primary">Pairing code: {s.pairing_code}</p>}
              <Button variant="outline" loading={pair.isPending} onClick={() => pair.mutate()}>Get pairing code</Button>
              <Button variant="danger" loading={off.isPending} onClick={() => off.mutate()}>Turn Luna Connect off</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-primary text-sm">
                Pick a short name so you can open Luna from a phone away from home at an address like photos.luna.servers.libreloom.org. No router changes. The address is free forever.
              </p>
              <label className="block text-primary text-sm">
                Name
                <input
                  className="mt-1 w-full rounded-pill bg-primary text-secondary px-4 py-2 font-mono"
                  placeholder="photos"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <p className="text-primary text-sm font-mono">{name ? `${name.toLowerCase()}.luna.servers.libreloom.org` : "name.luna.servers.libreloom.org"}</p>
              <Button variant="primary" fullWidth loading={activate.isPending} disabled={name.trim().length < 3} onClick={() => activate.mutate()}>
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
