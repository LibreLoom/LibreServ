import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, KeyRound, ShieldOff, Unplug } from "lucide-react";
import Page from "../components/ui/Page";
import Button from "../components/ui/Button";
import Pill from "../components/common/Pill";
import PageNotice from "../components/common/PageNotice";
import SettingsCard from "../components/settings/SettingsCard";
import SettingsRow from "../components/settings/SettingsRow";
import { getJson, postJson, apiErrorMessage } from "../lib/api";

export default function RemotePage() {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [newName, setNewName] = useState("");
  const [code, setCode] = useState("");
  const status = useQuery({ queryKey: ["connect-status"], queryFn: () => getJson("/api/v1/connect/status") });

  const change = useMutation({
    mutationFn: () => postJson("/api/v1/connect/domain", { subdomain: newName.trim().toLowerCase() }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connect-status"] }); setError(null); setNewName(""); },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const saveCode = useMutation({
    mutationFn: () => postJson("/api/v1/connect/setup-code", { code: code.trim() }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["connect-status"] }); setError(null); },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const redeem = useMutation({
    mutationFn: () => postJson("/api/v1/connect/redeem", {}),
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
      bottomContent={<p className="text-sm">Pick a name at connect.luna.libreloom.org. The address is free forever.</p>}
    >
      {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
      <div className="grid gap-5 md:grid-cols-2">
        <SettingsCard icon={Globe2} title="Luna Connect" headerActions={s.enabled ? <Pill variant="success">On</Pill> : <Pill variant="warning">Off</Pill>}>
          {s.enabled ? (
            <div className="space-y-3">
              <p className="text-primary text-sm">
                Your Luna is reachable anywhere at{" "}
                <span className="font-mono">{host || "your Luna address"}</span>.
                Open that address on a phone or computer the same way you open Luna at home, then sign in. That sign-in is a Luna account, not your Luna Connect account.
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
              <SettingsRow
                label="Change address"
                description="Pick a short name. Phones will open it as that-name.luna.servers.libreloom.org."
                stack
              >
                <input
                  className="w-full min-w-[12rem] rounded-pill bg-primary text-secondary px-4 py-2 font-mono"
                  placeholder="kitchen"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </SettingsRow>
              <p className="text-primary text-sm font-mono px-4">{newName ? `${newName.toLowerCase()}.luna.servers.libreloom.org` : "name.luna.servers.libreloom.org"}</p>
              <div className="px-4 pb-4 flex flex-col gap-2">
                <Button variant="primary" loading={change.isPending} disabled={newName.trim().length < 3} onClick={() => change.mutate()}>Save new address</Button>
                <Button variant="danger" loading={off.isPending} onClick={() => off.mutate()}>Turn Luna Connect off</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-primary text-sm">
                Code from the Luna Connect site. If you bought Luna, the booklet code is already on this disk — tap Use booklet code. If you set this computer up yourself, paste the short code from the website.
              </p>
              <SettingsRow
                label="Code from the Luna Connect site"
                description="Six letters from the website. If you bought Luna, the booklet code is already on this disk."
                stack
                hideDivider
              >
                <input
                  className="w-full min-w-[12rem] rounded-pill bg-primary text-secondary px-4 py-2 font-mono"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Six letters from the site"
                />
              </SettingsRow>
              <div className="px-4 pb-4 flex flex-col gap-2">
                <Button variant="primary" fullWidth loading={saveCode.isPending} disabled={code.trim().length < 6} onClick={() => saveCode.mutate()}>
                  Save code
                </Button>
                <Button variant="outline" fullWidth loading={redeem.isPending} onClick={() => redeem.mutate()}>
                  Use booklet code
                </Button>
              </div>
            </div>
          )}
        </SettingsCard>

        <SettingsCard icon={ShieldOff} title="Your own way">
          <p className="text-primary text-sm">
            Skip the free Luna address if you already run a private network. These steps are for someone who already knows the tool.
          </p>
          <ul className="mt-3 space-y-3 text-sm text-primary">
            <li className="flex items-start gap-2">
              <Unplug size={14} className="text-accent mt-1 shrink-0" />
              <span>
                Tailscale or WireGuard: install the app on Luna&apos;s computer, then on your phone. Open Luna at its private address from that app — often luna.local still works once both devices are on the same private network.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <KeyRound size={14} className="text-accent mt-1 shrink-0" />
              <span>
                Port forwarding: in your internet box, send web traffic (ports 80 and 443) to Luna. Then open Luna at your home&apos;s public internet address.
              </span>
            </li>
          </ul>
        </SettingsCard>
      </div>
    </Page>
  );
}
