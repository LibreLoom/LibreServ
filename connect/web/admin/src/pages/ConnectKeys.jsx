import { useCallback, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { StatusBadge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";
import { KeyRound, Copy, Check, Trash2 } from "lucide-react";

export default function ConnectKeys() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("all");
  const [listAll, setListAll] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [generatedKey, setGeneratedKey] = useState(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["connect-keys", listAll, filter],
    queryFn: () => api.listConnectKeys({ all: listAll, status: filter === "all" ? "" : filter }),
  });

  const keys = data?.connect_keys || [];
  const limited = data?.limited;

  const generateMut = useMutation({
    mutationFn: () => api.generateConnectKey(accountId.trim()),
    onSuccess: (res) => {
      setMessage("");
      setGeneratedKey(res);
      setAccountId("");
      queryClient.invalidateQueries({ queryKey: ["connect-keys"] });
      queryClient.invalidateQueries({ queryKey: ["customer-accounts"] });
    },
    onError: (err) => setMessage(err.message),
  });

  const revokeMut = useMutation({
    mutationFn: api.revokeConnectKey,
    onSuccess: () => {
      setMessage("");
      queryClient.invalidateQueries({ queryKey: ["connect-keys"] });
    },
    onError: (err) => setMessage(err.message),
  });

  const copyKey = useCallback(async (key) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage("Could not copy to clipboard.");
    }
  }, []);

  const handleRevoke = (keyId) => {
    if (!window.confirm("Revoke this unused Connect key? It will stop working immediately.")) return;
    revokeMut.mutate(keyId);
  };

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-2">Connect keys</h2>
      <p className="text-muted-foreground mb-6">
        Device activation keys for customer accounts. Full keys are shown only when you generate one for support.
      </p>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Generate for customer
          </CardTitle>
          <CardDescription>
            Paste a customer account ID from the Accounts page. This replaces any existing key on that account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 max-w-lg">
          <div>
            <Label htmlFor="account-id">Customer account ID</Label>
            <Input
              id="account-id"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="acc_..."
            />
          </div>
          <Button
            onClick={() => generateMut.mutate()}
            loading={generateMut.isPending}
            disabled={!accountId.trim()}
          >
            Generate Connect key
          </Button>
          {generatedKey && (
            <div className="rounded-large-element border border-success/30 p-4 space-y-3">
              <p className="text-sm text-muted-foreground">
                Give this key to the customer once. It will not be shown again in full.
              </p>
              <div className="flex items-center gap-2">
                <code className="font-mono text-sm flex-1 break-all">{generatedKey.connect_key}</code>
                <Button variant="outline" size="sm" onClick={() => copyKey(generatedKey.connect_key)}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setGeneratedKey(null)}>Dismiss</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Connect keys</CardTitle>
          <CardDescription>
            {limited
              ? "Newest 500 keys. Use Show all to load the full list."
              : "Every Connect key on this server."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {[
              { id: "all", label: "All" },
              { id: "unused", label: "Unused" },
              { id: "active", label: "Active" },
              { id: "revoked", label: "Revoked" },
            ].map((f) => (
              <Button
                key={f.id}
                size="sm"
                variant={filter === f.id ? "default" : "outline"}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => refetch()}>Refresh</Button>
            {limited ? (
              <Button size="sm" variant="secondary" onClick={() => setListAll(true)}>Show all</Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setListAll(false)}>Show newest 500</Button>
            )}
          </div>

          {isLoading ? (
            <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading Connect keys…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error.message}</p>
          ) : keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Connect keys in this filter.</p>
          ) : (
            <div className="overflow-x-auto rounded-large-element border border-border">
              <table className="w-full text-sm">
                <thead className="bg-card border-b border-border">
                  <tr className="text-left font-mono text-xs text-muted-foreground">
                    <th className="px-3 py-2">Prefix</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">Plan</th>
                    <th className="px-3 py-2">Device</th>
                    <th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className="border-b border-border last:border-0 align-top">
                      <td className="px-3 py-2 font-mono">{k.key_prefix}</td>
                      <td className="px-3 py-2"><StatusBadge status={k.status} /></td>
                      <td className="px-3 py-2 font-mono break-all max-w-[14rem]">{k.account_email || "—"}</td>
                      <td className="px-3 py-2">{k.plan_name}</td>
                      <td className="px-3 py-2 font-mono break-all max-w-[10rem]">
                        {k.subdomain || k.device_id || "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {new Date(k.created_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {k.can_revoke && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            loading={revokeMut.isPending}
                            onClick={() => handleRevoke(k.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {message && <p className="mt-4 text-sm text-destructive">{message}</p>}
    </Layout>
  );
}
