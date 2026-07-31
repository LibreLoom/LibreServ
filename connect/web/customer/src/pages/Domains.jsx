import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge, StatusBadge } from "../components/ui/badge.jsx";
import { Input } from "../components/ui/input.jsx";
import { Layout } from "../components/Layout.jsx";
import { Globe, Search, Loader2, Check, AlertCircle, RefreshCw } from "lucide-react";
import { cn } from "../lib/utils.js";

export default function Domains() {
  const { account } = useAuth();
  const queryClient = useQueryClient();
  const [searchModal, setSearchModal] = useState(null); // null | { deviceId, mode: "get" | "change" }
  const [cancelConfirm, setCancelConfirm] = useState(null); // null | domain name

  const verified = !!account?.email_verified;

  const { data: domainsData, isLoading } = useQuery({
    queryKey: ["domains"],
    queryFn: api.getDomains,
    enabled: verified,
  });

  const domains = domainsData?.domains || [];

  const cancelMut = useMutation({
    mutationFn: api.cancelDomain,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      setCancelConfirm(null);
    },
  });

  if (!verified) {
    return (
      <Layout>
        <h2 className="font-mono text-2xl mb-6">Domains</h2>
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">Verify your email to manage domains.</p>
          </CardContent>
        </Card>
      </Layout>
    );
  }

  if (isLoading) {
    return (
      <Layout>
        <h2 className="font-mono text-2xl mb-6">Domains</h2>
        <div className="flex items-center gap-3 py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <p className="font-mono text-sm text-muted-foreground">Loading domains…</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-mono text-2xl">Domains</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["domains"] })}
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </Button>
      </div>

      <div className="space-y-6">
        {domains.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-accent flex items-center justify-center mb-6">
                <Globe className="w-7 h-7 text-muted-foreground" />
              </div>
              <h3 className="font-mono text-xl mb-3">No custom domains yet</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mx-auto mb-8">
                Your device uses a free subdomain by default. Get a custom domain
                (like <span className="font-mono">myserver.com</span>) to make it
                easier to reach.
              </p>
              <Button size="lg" onClick={() => setSearchModal({ mode: "get" })}>
                Get a custom domain
              </Button>
            </CardContent>
          </Card>
        ) : (
          domains.map((d) => (
            <DomainCard
              key={d.id || d.domain}
              domain={d}
              cancelConfirm={cancelConfirm}
              setCancelConfirm={setCancelConfirm}
              cancelMut={cancelMut}
              onSearch={() => setSearchModal({ mode: "change", deviceId: d.device_id })}
            />
          ))
        )}
      </div>

      {searchModal && (
        <DomainSearchModal
          mode={searchModal.mode}
          deviceId={searchModal.deviceId}
          onClose={() => setSearchModal(null)}
        />
      )}
    </Layout>
  );
}

function DomainCard({ domain, cancelConfirm, setCancelConfirm, cancelMut, onSearch }) {
  const { domain: name, status, auto_renew, expires_at, device_id } = domain;
  const isExpiringSoon = expires_at && new Date(expires_at) && (new Date(expires_at) - new Date()) / 86400000 < 30;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-pill bg-accent flex items-center justify-center">
            <Globe className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <CardTitle className="font-mono text-base">{name}</CardTitle>
            <div className="flex items-center gap-2 mt-1">
              <StatusBadge status={status} />
              {auto_renew ? (
                <Badge variant="info">Auto-renew</Badge>
              ) : status === "active" ? (
                <Badge variant="warning">Manual renew</Badge>
              ) : null}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {expires_at && (
          <div className="flex items-center gap-2 mb-3 text-sm">
            {isExpiringSoon && status !== "cancelled" && status !== "expired" && (
              <AlertCircle className="w-4 h-4 text-warning" />
            )}
            <span className="text-muted-foreground">
              {status === "cancelled" || status === "expired"
                ? "Stops working on:"
                : auto_renew
                ? "Renews on:"
                : "Expires on:"}
            </span>
            <span className="font-mono">
              {new Date(expires_at).toLocaleDateString(undefined, {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </span>
          </div>
        )}

        {status === "payment_failed" && (
          <div className="rounded-large-element bg-error/20 border border-error/30 px-4 py-3 mb-4">
            <p className="text-sm text-error">
              We could not charge your account credit for the last renewal.
              Top up your credit balance in Billing to restore this domain.
            </p>
          </div>
        )}

        {status === "grace" && (
          <div className="rounded-large-element bg-warning/20 border border-warning/30 px-4 py-3 mb-4">
            <p className="text-sm text-warning">
              This domain is in grace period. It will stop working on the expiry
              date above. The domain will not auto-renew.
            </p>
          </div>
        )}

        {(status === "active" || status === "grace" || status === "payment_failed") && (
          <div className="flex items-center gap-3 mt-4">
            {cancelConfirm === name ? (
              <>
                <span className="text-sm text-muted-foreground">Are you sure?</span>
                <Button
                  variant="destructive"
                  size="sm"
                  loading={cancelMut.isPending}
                  onClick={() => cancelMut.mutate(name)}
                >
                  Yes, cancel
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setCancelConfirm(null)}>
                  Keep it
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={onSearch}>
                  Change domain
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => setCancelConfirm(name)}
                >
                  Cancel domain
                </Button>
              </>
            )}
          </div>
        )}

        {(status === "cancelled" || status === "expired") && (
          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={onSearch}>
              Get a new domain
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DomainSearchModal({ mode, deviceId, onClose }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [checking, setChecking] = useState(null);
  const [purchasing, setPurchasing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSearch = async () => {
    if (!query.trim()) return;
    setError("");
    setSuccess("");
    try {
      const res = await api.searchDomains(query);
      setResults(res.domains || res.results || []);
    } catch (err) {
      setError(err.message || "Could not search domains.");
    }
  };

  const handleCheck = async (domain) => {
    setChecking(domain);
    setError("");
    try {
      const res = await api.checkDomain(domain);
      setResults((prev) =>
        prev.map((d) => (d.name === domain ? { ...d, available: res.available || res.registrable, price: res.registration_cost } : d))
      );
    } catch (err) {
      setError(err.message || "Could not check availability.");
    } finally {
      setChecking(null);
    }
  };

  const handlePurchase = async (domain) => {
    setPurchasing(true);
    setError("");
    try {
      const res = await api.registerDomain(deviceId || "", domain);
      if (res.checkout_url) {
        window.location.href = res.checkout_url;
      } else {
        setSuccess(`${domain} registered successfully!`);
        setTimeout(() => onClose(), 2000);
      }
    } catch (err) {
      setError(err.message || "Could not register domain. Try again.");
    } finally {
      setPurchasing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-large-element border border-border bg-card text-card-foreground shadow-[0_8px_32px_rgba(0,0,0,0.16)] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-pill bg-accent flex items-center justify-center">
            <Globe className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="font-mono text-lg">
              {mode === "change" ? "Change your domain" : "Get a custom domain"}
            </h3>
            <p className="text-sm text-muted-foreground">
              You pay exactly what we pay — no markup on the registration price.
            </p>
          </div>
        </div>

        {success ? (
          <div className="text-center py-8">
            <div className="mx-auto w-12 h-12 rounded-full bg-success/20 flex items-center justify-center mb-4">
              <Check className="w-6 h-6 text-success" />
            </div>
            <p className="font-mono text-sm">{success}</p>
          </div>
        ) : (
          <>
            <div className="flex gap-2 mb-4">
              <Input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="my-site"
                onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
                autoFocus
              />
              <Button variant="outline" size="icon" onClick={handleSearch} disabled={!query.trim()}>
                <Search className="w-4 h-4" />
              </Button>
            </div>

            {error && (
              <p className="text-sm text-error mb-4">{error}</p>
            )}

            {results.length > 0 && (
              <div className="space-y-2.5 max-h-80 overflow-y-auto">
                {results.map((result) => {
                  const checked = result.available !== undefined;
                  return (
                    <div
                      key={result.name}
                      className={cn(
                        "flex items-center justify-between rounded-large-element border p-3.5 gap-3",
                        result.available ? "border-success/30 bg-success/5" : "border-border"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <span className="font-mono text-sm text-card-foreground">{result.name}</span>
                        {(result.price || result.registration_cost) && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            ${result.price || result.registration_cost}/year
                          </span>
                        )}
                      </div>
                      {checked ? (
                        result.available ? (
                          <div className="flex items-center gap-2">
                            <Badge variant="success">Available</Badge>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handlePurchase(result.name)}
                              disabled={purchasing}
                            >
                              {purchasing ? <Loader2 className="w-3 h-3 animate-spin" /> : "Register"}
                            </Button>
                          </div>
                        ) : (
                          <Badge variant="outline">Taken</Badge>
                        )
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleCheck(result.name)}
                          disabled={checking === result.name}
                        >
                          {checking === result.name ? <Loader2 className="w-3 h-3 animate-spin" /> : "Check"}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex justify-end mt-6">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
