import { useCallback, useEffect, useState } from "react";
import { AdminLayout } from "../components/AdminLayout.jsx";
import { Badge, DeviceTokenStatusBadge, StatusBadge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { adminApi } from "../context/AdminAuthContext.jsx";
import { Copy, Check, KeyRound, Shield, Trash2, Users } from "lucide-react";

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

export default function AdminAccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mintedCode, setMintedCode] = useState("");
  const [mintBusy, setMintBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadAccounts = useCallback(() => {
    setError("");
    setLoading(true);
    adminApi("/admin/accounts")
      .then((data) => setAccounts(data.accounts || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setMintedCode("");
      return;
    }
    setDetailLoading(true);
    setDetailError("");
    setMintedCode("");
    adminApi(`/admin/accounts/${encodeURIComponent(selectedId)}`)
      .then(setDetail)
      .catch((err) => setDetailError(err.message))
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  const mintReplacement = async () => {
    if (!selectedId) return;
    setMintBusy(true);
    setDetailError("");
    try {
      const data = await adminApi("/admin/setup-tokens", {
        method: "POST",
        body: JSON.stringify({ order_ref: `support:${selectedId}` }),
      });
      setMintedCode(data.code || "");
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setMintBusy(false);
    }
  };

  const copyCode = async () => {
    if (!mintedCode) return;
    try {
      await navigator.clipboard.writeText(mintedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setDetailError("Could not copy to clipboard.");
    }
  };

  const deleteAccount = async () => {
    if (!selectedId || !detail) return;
    const msg = `Delete ${detail.email}? This signs the customer out, purges linked Lunas, and removes the account. Cloud backups stay in storage.`;
    if (!window.confirm(msg)) return;
    setDeleteBusy(true);
    setDetailError("");
    try {
      await adminApi(`/admin/accounts/${encodeURIComponent(selectedId)}`, { method: "DELETE" });
      setSelectedId(null);
      setDetail(null);
      loadAccounts();
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <AdminLayout>
      <h2 className="font-mono text-2xl mb-2">Accounts</h2>
      <p className="text-muted-foreground mb-6">
        Customer Luna Connect sign-ins. Open an account to see linked Lunas and mint a replacement device token.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-4 w-4" /> Customers
            </CardTitle>
            <CardDescription>{accounts.length} account{accounts.length === 1 ? "" : "s"}</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading accounts…</p>
            ) : error ? (
              <p className="text-sm text-error">{error}</p>
            ) : accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No customer accounts yet.</p>
            ) : (
              <ul className="space-y-2">
                {accounts.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(a.id)}
                      className={`w-full text-left rounded-large-element border border-border px-4 py-3 transition-colors hover:bg-accent/30 ${
                        selectedId === a.id ? "ring-2 ring-ring" : ""
                      }`}
                    >
                      <p className="font-mono text-sm break-all">{a.email}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {a.device_count} Luna{a.device_count === 1 ? "" : "s"} · created {formatWhen(a.created_at)}
                      </p>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {a.email_verified ? (
                          <Badge variant="success">Email verified</Badge>
                        ) : (
                          <Badge variant="warning">Email not verified</Badge>
                        )}
                        <Badge variant={a.has_card ? "success" : "outline"}>
                          {a.has_card ? "Card on file" : "No card"}
                        </Badge>
                        <StatusBadge status={a.billing_status || "none"} />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {selectedId && (
          <Card className="animate-fade-in" data-testid="account-detail">
            <CardHeader>
              <CardTitle>Account details</CardTitle>
              <CardDescription className="font-mono break-all">{detail?.email || selectedId}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {detailLoading ? (
                <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading account…</p>
              ) : detailError && !detail ? (
                <p className="text-sm text-error">{detailError}</p>
              ) : detail ? (
                <>
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Account ID</dt>
                      <dd className="font-mono break-all text-right">{detail.id}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted-foreground">Created</dt>
                      <dd className="font-mono">{formatWhen(detail.created_at)}</dd>
                    </div>
                  </dl>

                  <section>
                    <h3 className="font-mono text-sm mb-2 flex items-center gap-2">
                      <Shield className="h-4 w-4" /> Linked Lunas
                    </h3>
                    {(detail.devices || []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No Lunas linked yet.</p>
                    ) : (
                      <ul className="space-y-2">
                        {detail.devices.map((d) => (
                          <li key={d.id} className="rounded-large-element border border-border px-3 py-2 text-sm">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono truncate">{d.device_hostname || d.hint || d.id}</span>
                              <DeviceTokenStatusBadge status={d.status} />
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              {kindLabel(d.kind)}
                              {d.online ? " · online" : ""}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section>
                    <h3 className="font-mono text-sm mb-2 flex items-center gap-2">
                      <KeyRound className="h-4 w-4" /> Replacement device token
                    </h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      Mint a new token for support. The customer enters it on Luna during setup or in Settings → About → Advanced.
                    </p>
                    <Button loading={mintBusy} onClick={mintReplacement}>
                      Mint replacement token
                    </Button>
                    {mintedCode && (
                      <div className="rounded-large-element border border-success/30 p-4 mt-4 space-y-3">
                        <p className="text-sm text-muted-foreground">Shown once — copy it now.</p>
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-sm flex-1 break-all tracking-widest">{mintedCode}</code>
                          <Button variant="outline" size="sm" onClick={copyCode}>
                            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          </Button>
                        </div>
                      </div>
                    )}
                  </section>

                  <section className="rounded-large-element border border-error/30 bg-error/10 p-4">
                    <h3 className="font-mono text-sm mb-2 flex items-center gap-2 text-error">
                      <Trash2 className="h-4 w-4" /> Delete account
                    </h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      Remove this customer account and purge linked Lunas. Cloud backups stay in storage for retention.
                    </p>
                    <Button variant="destructive" loading={deleteBusy} onClick={deleteAccount}>
                      Delete account
                    </Button>
                  </section>
                </>
              ) : null}
              {detailError && detail && <p className="text-sm text-error">{detailError}</p>}
            </CardContent>
          </Card>
        )}
      </div>
    </AdminLayout>
  );
}
