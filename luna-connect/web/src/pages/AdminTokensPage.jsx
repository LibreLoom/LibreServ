import { useCallback, useEffect, useState } from "react";
import { AdminLayout } from "../components/AdminLayout.jsx";
import { Badge, StatusBadge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { adminApi } from "../context/AdminAuthContext.jsx";

function downloadTokensFile(tokens) {
  const body = `${tokens.join("\n")}\n`;
  const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "TOKENS";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatWhen(unix) {
  if (!unix) return "—";
  try {
    return new Date(Number(unix) * 1000).toLocaleString();
  } catch {
    return "—";
  }
}

function kindLabel(kind) {
  if (kind === "oss") return "Website";
  if (kind === "official") return "Official";
  return kind || "—";
}

export default function AdminTokensPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [bulkCount, setBulkCount] = useState("100");
  const [bulkTokens, setBulkTokens] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [singleBusy, setSingleBusy] = useState(false);
  const [rows, setRows] = useState([]);
  const [listError, setListError] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [listAll, setListAll] = useState(false);
  const [listLimited, setListLimited] = useState(true);
  const [revokeBusy, setRevokeBusy] = useState("");
  const [filter, setFilter] = useState("all");

  const loadTokens = useCallback(async (all = false) => {
    setListError("");
    setListLoading(true);
    try {
      const path = all ? "/admin/setup-tokens?all=1" : "/admin/setup-tokens";
      const data = await adminApi(path);
      setRows(data.tokens || []);
      setListAll(all);
      setListLimited(data.limited !== false && !all);
    } catch (err) {
      setListError(err.message);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTokens(false);
  }, [loadTokens]);

  const revoke = async (id) => {
    if (!window.confirm("Revoke this unused setup code? It will no longer work for pairing.")) return;
    setRevokeBusy(id);
    setError("");
    try {
      await adminApi(`/admin/setup-tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadTokens(listAll);
    } catch (err) {
      setError(err.message);
    } finally {
      setRevokeBusy("");
    }
  };

  const visible = rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "issued") return r.status === "issued";
    if (filter === "claimed") return r.status === "claimed";
    if (filter === "revoked") return r.status === "revoked" || r.status === "expired";
    return true;
  });

  return (
    <AdminLayout>
      <h2 className="font-mono text-2xl mb-2">Setup codes</h2>
      <p className="text-muted-foreground mb-8">
        Official setup codes are created here. The public OS image has no code. Factory lists go on the installer USB as a file named TOKENS. Full codes are shown only at mint time — after that the table keeps a short hint, status, and linked account.
      </p>

      <Card className="mb-6" data-testid="official-token-recovery">
        <CardHeader>
          <CardTitle>Lost device code</CardTitle>
          <CardDescription>
            Owners who already finished setup can mint a new device code on their Luna Connect page. Use this page when there is no account yet, or the code was lost before first setup. The owner should contact support and refer to their order ID. Paste the replacement on Luna, or put it on the installer USB: add a line to TOKENS on the LUNAASSETS partition.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Single device code</CardTitle>
          <CardDescription>Create one device code to print in a box or give as a replacement (****-****-****-****-****). Copy it now — it will not be shown again in full.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            loading={singleBusy}
            onClick={async () => {
              setError("");
              setSingleBusy(true);
              try {
                const data = await adminApi("/admin/setup-tokens", { method: "POST", body: "{}" });
                setToken(data.token);
                await loadTokens(listAll);
              } catch (err) {
                setError(err.message);
              } finally {
                setSingleBusy(false);
              }
            }}
          >
            New token
          </Button>
          {token && <p className="font-mono text-xl tracking-widest break-all">{token}</p>}
        </CardContent>
      </Card>

      <Card className="mb-6" data-testid="bulk-tokens">
        <CardHeader>
          <CardTitle>Bulk factory tokens</CardTitle>
          <CardDescription>
            Create many device codes for the installer USB. Download the list as TOKENS (one code per line) and put that file on the LUNAASSETS partition.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-xs">
            <Label htmlFor="bulk-count">How many</Label>
            <Input
              id="bulk-count"
              type="number"
              min={1}
              max={10000}
              value={bulkCount}
              onChange={(e) => setBulkCount(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              loading={bulkBusy}
              onClick={async () => {
                setError("");
                setBulkBusy(true);
                try {
                  const n = Number.parseInt(bulkCount, 10);
                  const data = await adminApi("/admin/setup-tokens/bulk", {
                    method: "POST",
                    body: JSON.stringify({ count: n }),
                  });
                  setBulkTokens(data.tokens || []);
                  await loadTokens(listAll);
                } catch (err) {
                  setError(err.message);
                } finally {
                  setBulkBusy(false);
                }
              }}
            >
              Create list
            </Button>
            <Button
              variant="secondary"
              disabled={bulkTokens.length === 0}
              onClick={() => downloadTokensFile(bulkTokens)}
            >
              Download TOKENS
            </Button>
          </div>
          {bulkTokens.length > 0 && (
            <div className="rounded-large-element border border-border bg-background p-4">
              <p className="font-mono text-sm text-muted-foreground mb-2">
                {bulkTokens.length} codes · file name TOKENS
              </p>
              <pre className="font-mono text-sm max-h-64 overflow-auto whitespace-pre-wrap break-all">
                {bulkTokens.join("\n")}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="setup-codes-table">
        <CardHeader>
          <CardTitle>Issued codes</CardTitle>
          <CardDescription>
            {listAll || !listLimited
              ? "Every setup code on this Luna Connect. Revoke unused ones. Claimed rows show the customer account and Luna when known."
              : "Newest 500 codes by default. Use Show all codes to load the full list. Revoke unused ones. Claimed rows show the customer account and Luna when known."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {[
              { id: "all", label: "All" },
              { id: "issued", label: "Unused" },
              { id: "claimed", label: "Claimed" },
              { id: "revoked", label: "Revoked / expired" },
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
            <Button size="sm" variant="ghost" onClick={() => loadTokens(listAll)}>
              Refresh
            </Button>
            {listLimited && !listAll ? (
              <Button size="sm" variant="secondary" onClick={() => loadTokens(true)}>
                Show all codes
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => loadTokens(false)}>
                Show newest 500
              </Button>
            )}
          </div>
          {listLoading ? (
            <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading codes…</p>
          ) : listError ? (
            <p className="text-sm text-error">{listError}</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No setup codes in this filter.</p>
          ) : (
            <div className="overflow-x-auto rounded-large-element border border-border">
              <table className="w-full text-sm">
                <thead className="bg-card border-b border-border">
                  <tr className="text-left font-mono text-xs text-muted-foreground">
                    <th className="px-3 py-2">Hint</th>
                    <th className="px-3 py-2">Kind</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">Device</th>
                    <th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2">Expires</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0 align-top">
                      <td className="px-3 py-2 font-mono">{r.hint || "—"}</td>
                      <td className="px-3 py-2">
                        <Badge variant="outline">{kindLabel(r.kind)}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2 font-mono break-all max-w-[14rem]">
                        {r.account_email || "—"}
                      </td>
                      <td className="px-3 py-2 font-mono break-all max-w-[14rem]">
                        {r.device_hostname || r.device_name || "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatWhen(r.created_at)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatWhen(r.expires_at)}</td>
                      <td className="px-3 py-2 text-right">
                        {r.can_revoke && (
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={revokeBusy === r.id}
                            onClick={() => revoke(r.id)}
                          >
                            Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!listLoading && !listError && rows.length > 0 && (
            <p className="font-mono text-xs text-muted-foreground">
              Showing {visible.length}
              {filter !== "all" ? ` matching filter (${rows.length} loaded)` : " loaded"}
              {listLimited && !listAll ? " · capped at newest 500" : ""}
            </p>
          )}
        </CardContent>
      </Card>

      {error && <p className="mt-4 text-sm text-error">{error}</p>}
    </AdminLayout>
  );
}
