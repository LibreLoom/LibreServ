import { useCallback, useEffect, useState } from "react";
import { AdminLayout } from "../components/AdminLayout.jsx";
import { Badge, DeviceTokenStatusBadge, StatusBadge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Input } from "../components/ui/input.jsx";
import TokenReveal from "../components/TokenReveal.jsx";
import { adminApi } from "../context/AdminAuthContext.jsx";
import { ChevronDown, ChevronUp, ExternalLink, RefreshCw, Shield, Trash2, Users } from "lucide-react";

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

function tunnelStatusLabel(device) {
  if (device.revoked) return { text: "Revoked", variant: "destructive" };
  if (!device.subdomain && !device.device_hostname) {
    return { text: "No address", variant: "outline" };
  }
  if (!device.has_tunnel) {
    return { text: "Connection missing", variant: "warning" };
  }
  if (device.online) {
    return { text: "Online", variant: "success" };
  }
  return { text: "Offline", variant: "outline" };
}

function publicURL(hostname) {
  if (!hostname) return null;
  return `https://${hostname}`;
}

function LinkedLunaRow({ device, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [subdomain, setSubdomain] = useState(device.subdomain || "");
  const [domainBusy, setDomainBusy] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState("");

  useEffect(() => {
    setSubdomain(device.subdomain || "");
  }, [device.subdomain, device.id]);

  const loadDetail = async () => {
    setDetailLoading(true);
    setDetailError("");
    try {
      const data = await adminApi(`/admin/devices/${encodeURIComponent(device.id)}`);
      setDetail(data);
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setDetailLoading(false);
    }
  };

  const toggleView = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!detail) {
      await loadDetail();
    }
  };

  const regenerateTunnel = async () => {
    const host = device.device_hostname || "this Luna";
    const msg =
      `Create a new secure connection for ${host}? ` +
      "Luna will pick it up on the next sync (about 5 minutes). The public address stays the same.";
    if (!window.confirm(msg)) return;
    setRegenBusy(true);
    setActionMsg("");
    setDetailError("");
    try {
      await adminApi(`/admin/devices/${encodeURIComponent(device.id)}/regenerate-tunnel`, { method: "POST" });
      setActionMsg("New secure connection created. Luna will sync it within about 5 minutes.");
      setDetail(null);
      if (expanded) await loadDetail();
      onRefresh();
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setRegenBusy(false);
    }
  };

  const saveAddress = async () => {
    const trimmed = subdomain.trim();
    if (!trimmed) {
      setDetailError("Type the part before the dot in the address (the subdomain).");
      return;
    }
    setDomainBusy(true);
    setActionMsg("");
    setDetailError("");
    try {
      const data = await adminApi(`/admin/devices/${encodeURIComponent(device.id)}/domain`, {
        method: "POST",
        body: JSON.stringify({ subdomain: trimmed }),
      });
      setActionMsg(`Address updated to ${data.hostname || trimmed}.`);
      setDetail(null);
      if (expanded) await loadDetail();
      onRefresh();
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setDomainBusy(false);
    }
  };

  const tunnel = tunnelStatusLabel(device);
  const url = publicURL(device.device_hostname);

  return (
    <li className="rounded-large-element border border-border px-3 py-3 text-sm space-y-3" data-testid={`luna-row-${device.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-sm break-all inline-flex items-center gap-1 hover:underline"
            >
              {device.device_hostname}
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
            </a>
          ) : (
            <span className="font-mono truncate">{device.hint || device.id}</span>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            {kindLabel(device.kind)}
            {device.last_seen_at ? ` · last seen ${formatWhen(device.last_seen_at)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Badge variant={tunnel.variant}>{tunnel.text}</Badge>
          <DeviceTokenStatusBadge status={device.status} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={toggleView}>
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          {expanded ? "Hide details" : "View"}
        </Button>
        {device.subdomain && (
          <Button variant="outline" size="sm" loading={regenBusy} onClick={regenerateTunnel}>
            <RefreshCw className="h-4 w-4" />
            Regenerate connection
          </Button>
        )}
      </div>

      {expanded && (
        <div className="rounded-large-element border border-border bg-muted/30 p-3 space-y-3" data-testid={`luna-detail-${device.id}`}>
          {detailLoading ? (
            <p className="text-xs text-muted-foreground animate-pulse">Loading Luna details…</p>
          ) : detail ? (
            <dl className="space-y-1 text-xs">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Luna ID</dt>
                <dd className="font-mono break-all text-right">{detail.id}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Connection ID</dt>
                <dd className="font-mono break-all text-right">{detail.tunnel_id || "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Account</dt>
                <dd className="font-mono break-all text-right">{detail.account_email || "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Created</dt>
                <dd className="font-mono">{formatWhen(detail.created_at)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Last seen</dt>
                <dd className="font-mono">{formatWhen(detail.last_seen_at)}</dd>
              </div>
              <div className="flex justify-between gap-4 items-start">
                <dt className="text-muted-foreground shrink-0 pt-1">Device token</dt>
                <dd className="text-right max-w-[min(100%,20rem)]">
                  <TokenReveal
                    hint={detail.hint || device.hint}
                    code={detail.code}
                    label="token"
                    compact
                  />
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Status</dt>
                <dd>{detail.online ? "Online now" : "Not online recently"}</dd>
              </div>
            </dl>
          ) : null}
          {detailError && <p className="text-xs text-error">{detailError}</p>}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Change the subdomain (the part before .luna.servers.libreloom.org). Luna syncs the new address on its next check-in.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value)}
            placeholder="myluna"
            className="max-w-[200px]"
            aria-label="Subdomain"
          />
          <span className="text-xs text-muted-foreground font-mono">.luna.servers.libreloom.org</span>
          <Button variant="secondary" size="sm" loading={domainBusy} onClick={saveAddress}>
            Save address
          </Button>
        </div>
      </div>

      {actionMsg && <p className="text-xs text-success">{actionMsg}</p>}
      {!expanded && detailError && <p className="text-xs text-error">{detailError}</p>}
    </li>
  );
}

export default function AdminAccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const loadAccounts = useCallback(() => {
    setError("");
    setLoading(true);
    adminApi("/admin/accounts")
      .then((data) => setAccounts(data.accounts || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const loadDetail = useCallback(() => {
    if (!selectedId) return;
    setDetailLoading(true);
    setDetailError("");
    adminApi(`/admin/accounts/${encodeURIComponent(selectedId)}`)
      .then(setDetail)
      .catch((err) => setDetailError(err.message))
      .finally(() => setDetailLoading(false));
  }, [selectedId]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    loadDetail();
  }, [selectedId, loadDetail]);

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
        Customer Luna Connect sign-ins. Open an account to see linked Lunas, their addresses, and manage secure connections.
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
                      <ul className="space-y-3">
                        {detail.devices.map((d) => (
                          <LinkedLunaRow key={d.id} device={d} onRefresh={loadDetail} />
                        ))}
                      </ul>
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
