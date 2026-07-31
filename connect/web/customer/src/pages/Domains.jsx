import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Input } from "../components/ui/input.jsx";
import { Layout } from "../components/Layout.jsx";
import { Globe, Search, Loader2, Check, RefreshCw, Star, Link as LinkIcon } from "lucide-react";
import { cn } from "../lib/utils.js";

/**
 * Domains — generic domain page.
 *
 * Shows the domain each of your devices is currently served from and lets you
 * switch it: get a custom domain, or fall back to the plan-provided subdomain
 * (e.g. abcd1234.servers.libreloom.org, or *.free.servers.libreloom.org on the
 * free plan). A custom domain overrides the subdomain — switching back to the
 * subdomain drops the custom domain (it stops renewing and expires naturally).
 */
export default function Domains() {
  const { account } = useAuth();
  const queryClient = useQueryClient();
  const [searchModal, setSearchModal] = useState(null); // null | { deviceId, mode: "get" | "change" }
  const [switchConfirm, setSwitchConfirm] = useState(null); // null | deviceId
  const [error, setError] = useState("");

  const verified = !!account?.email_verified;

  const { data: devicesData, isLoading } = useQuery({
    queryKey: ["devices"],
    queryFn: api.getDevices,
    enabled: verified,
  });

  const devices = devicesData?.devices || [];

  const useSubdomainMut = useMutation({
    mutationFn: api.useSubdomain,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      setSwitchConfirm(null);
    },
    onError: (err) => setError(err.message || "Could not switch to your subdomain."),
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
          <p className="font-mono text-sm text-muted-foreground">Loading your domains…</p>
        </div>
      </Layout>
    );
  }

  const activeDevices = devices.filter((d) => d.is_active);

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-mono text-2xl">Domain</h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: ["devices"] });
            queryClient.invalidateQueries({ queryKey: ["domains"] });
          }}
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </Button>
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed mb-6 max-w-2xl">
        This is the address people use to reach your server. Your plan includes a{" "}
        <span className="font-mono">{activeDevices[0]?.plan_domain || "subdomain"}</span>{" "}
        subdomain — you can keep it, or use a custom domain (like{" "}
        <span className="font-mono">myserver.com</span>) instead.
      </p>

      {error && (
        <div className="rounded-large-element bg-error/20 border border-error/30 px-4 py-3 mb-6">
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      <div className="space-y-6">
        {activeDevices.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-accent flex items-center justify-center mb-6">
                <Globe className="w-7 h-7 text-muted-foreground" />
              </div>
              <h3 className="font-mono text-xl mb-3">No active device</h3>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mx-auto mb-8">
                Connect a device first to choose its domain.
              </p>
            </CardContent>
          </Card>
        ) : (
          activeDevices.map((device) => (
            <DeviceDomainCard
              key={device.id}
              device={device}
              switchConfirm={switchConfirm}
              setSwitchConfirm={setSwitchConfirm}
              useSubdomainMut={useSubdomainMut}
              onGetCustom={() => setSearchModal({ deviceId: device.id, mode: "get" })}
              onGetNewCustom={() => setSearchModal({ deviceId: device.id, mode: "change" })}
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

function DeviceDomainCard({ device, switchConfirm, setSwitchConfirm, useSubdomainMut, onGetCustom, onGetNewCustom }) {
  const {
    plan_name,
    current_domain,
    subdomain,
    custom_domain,
    has_custom_domain,
  } = device;

  const isCustom = !!has_custom_domain;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-3">
          <div className={cn("w-10 h-10 rounded-pill flex items-center justify-center", isCustom ? "bg-primary text-secondary" : "bg-accent")}>
            {isCustom ? <Star className="w-5 h-5" /> : <LinkIcon className="w-5 h-5" />}
          </div>
          <div>
            <CardTitle className="font-mono text-base">{current_domain}</CardTitle>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={isCustom ? "success" : "info"}>
                {isCustom ? "Custom domain" : "Plan subdomain"}
              </Badge>
              <span className="text-xs text-muted-foreground">{device.plan_name}</span>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {isCustom ? (
          <p className="text-sm text-muted-foreground mb-4">
            Your custom domain <span className="font-mono">{current_domain}</span> routes
            to this device. Your plan's default subdomain{" "}
            <span className="font-mono">{subdomain}</span> is on standby until you drop the
            custom domain.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground mb-4">
            This device is served from your plan's subdomain{" "}
            <span className="font-mono">{subdomain}</span>. You can put a custom domain in
            front of it at any time.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {isCustom ? (
            <div className="rounded-large-element border border-border p-4">
              <div className="flex items-center gap-2 text-sm font-medium mb-1">
                <LinkIcon className="w-4 h-4 text-muted-foreground" />
                Use my plan's subdomain
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Free with every plan. The custom domain above stops renewing and
                expires on its current renewal date.
              </p>
              {switchConfirm === device.id ? (
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    loading={useSubdomainMut.isPending}
                    onClick={() => useSubdomainMut.mutate(device.id)}
                  >
                    Yes, switch
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setSwitchConfirm(null)}>
                    Keep custom
                  </Button>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setSwitchConfirm(device.id)}>
                  Switch to subdomain
                </Button>
              )}
            </div>
          ) : (
            <div className="rounded-large-element border border-border p-4">
              <div className="flex items-center gap-2 text-sm font-medium mb-1">
                <Star className="w-4 h-4 text-muted-foreground" />
                Use a custom domain
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Put your own branded domain in front. You pay exactly what we pay — no
                markup on the registration price.
              </p>
              <Button variant="outline" size="sm" onClick={onGetCustom}>
                Get a custom domain
              </Button>
            </div>
          )}

          {isCustom && (
            <div className="rounded-large-element border border-border p-4">
              <div className="flex items-center gap-2 text-sm font-medium mb-1">
                <Star className="w-4 h-4 text-muted-foreground" />
                Use a different custom domain
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                Replace this domain with a new one. The current one is cancelled.
              </p>
              <Button variant="outline" size="sm" onClick={onGetNewCustom}>
                Change custom domain
              </Button>
            </div>
          )}
        </div>
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
            <Star className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="font-mono text-lg">
              {mode === "change" ? "Change your custom domain" : "Get a custom domain"}
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