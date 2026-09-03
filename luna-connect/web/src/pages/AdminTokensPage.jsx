import { useCallback, useEffect, useState } from "react";
import { AdminLayout } from "../components/AdminLayout.jsx";
import { Badge, DeviceTokenStatusBadge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import ShakeTarget from "../components/ui/shake-target.jsx";
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
  if (kind === "diy") return "DIY";
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
  const [purgeBusy, setPurgeBusy] = useState("");
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
    if (!window.confirm("Revoke this unused device token? It will no longer work for setup or sign-in.")) return;
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

  const purge = async (row) => {
    const label = row.device_hostname || row.hint || row.id;
    const bound = row.status === "bound";
    const msg = bound
      ? `Purge ${label}? This disconnects the Luna from its account, stops remote access, and deletes the token. Cloud backups stay in storage.`
      : `Purge ${label}? This deletes the token permanently. It will no longer work for setup or hello.`;
    if (!window.confirm(msg)) return;
    setPurgeBusy(row.id);
    setError("");
    try {
      await adminApi(`/admin/setup-tokens/${encodeURIComponent(row.id)}/purge`, { method: "POST" });
      await loadTokens(listAll);
    } catch (err) {
      setError(err.message);
    } finally {
      setPurgeBusy("");
    }
  };

  const visible = rows.filter((r) => {
    if (filter === "all") return true;
    if (filter === "unbound") return r.status === "unbound";
    if (filter === "bound") return r.status === "bound";
    if (filter === "revoked") return r.status === "revoked";
    return true;
  });

  return (
    <AdminLayout>
      <h2 className="font-mono text-2xl mb-2">Device tokens</h2>
      <p className="text-muted-foreground mb-8">
        Each device token is one Luna. Mint tokens here for factory USB sticks, retail boxes, or a one-off code for support. The public OS image ships without a token. Full codes are shown only at mint time — after that this table keeps a short hint, status, linked account, and address when set.
      </p>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Single device token</CardTitle>
          <CardDescription>Create one token to print in a box or hand to support (****-****-****-****-****). Copy it now — it will not be shown again in full.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            loading={singleBusy}
            onClick={async () => {
              setError("");
              setSingleBusy(true);
              try {
                const data = await adminApi("/admin/setup-tokens", { method: "POST", body: "{}" });
                setToken(data.code);
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
            Create many device tokens for the installer USB. Download the list as TOKENS (one token per line) and put that file on the LUNAASSETS partition.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-xs">
            <Label htmlFor="bulk-count">How many</Label>
            <ShakeTarget shake={error}>
              <Input
                id="bulk-count"
                type="number"
                min={1}
                max={10000}
                value={bulkCount}
                onChange={(e) => setBulkCount(e.target.value)}
              />
            </ShakeTarget>
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
                {bulkTokens.length} tokens · file name TOKENS
              </p>
              <pre className="font-mono text-sm max-h-64 overflow-auto whitespace-pre-wrap break-all">
                {bulkTokens.join("\n")}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="device-tokens-table">
        <CardHeader>
          <CardTitle>All device tokens</CardTitle>
          <CardDescription>
            {listAll || !listLimited
              ? "Every Luna on this Connect. Revoke unused tokens. Bound rows show the customer account and address when set."
              : "Newest 500 tokens by default. Use Show all to load the full list. Revoke unused ones. Bound rows show the customer account and address when set."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {[
              { id: "all", label: "All" },
              { id: "unbound", label: "Unused" },
              { id: "bound", label: "Bound" },
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
            <Button size="sm" variant="ghost" onClick={() => loadTokens(listAll)}>
              Refresh
            </Button>
            {listLimited && !listAll ? (
              <Button size="sm" variant="secondary" onClick={() => loadTokens(true)}>
                Show all
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => loadTokens(false)}>
                Show newest 500
              </Button>
            )}
          </div>
          {listLoading ? (
            <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading device tokens…</p>
          ) : listError ? (
            <p className="text-sm text-error">{listError}</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No device tokens in this filter.</p>
          ) : (
            <div className="overflow-x-auto rounded-large-element border border-border">
              <table className="w-full text-sm">
                <thead className="bg-card border-b border-border">
                  <tr className="text-left font-mono text-xs text-muted-foreground">
                    <th className="px-3 py-2">Hint</th>
                    <th className="px-3 py-2">Kind</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Account</th>
                    <th className="px-3 py-2">Address</th>
                    <th className="px-3 py-2">Created</th>
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
                        <DeviceTokenStatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2 font-mono break-all max-w-[14rem]">
                        {r.account_email || "—"}
                      </td>
                      <td className="px-3 py-2 font-mono break-all max-w-[14rem]">
                        {r.device_hostname || "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatWhen(r.created_at)}</td>
                      <td className="px-3 py-2 text-right space-x-1 whitespace-nowrap">
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
                        <Button
                          size="sm"
                          variant="destructive"
                          loading={purgeBusy === r.id}
                          onClick={() => purge(r)}
                        >
                          Purge
                        </Button>
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
