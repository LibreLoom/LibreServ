import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Input } from "../components/ui/input.jsx";
import { Layout } from "../components/Layout.jsx";
import {
  Globe, Link as LinkIcon, Star, Search, Loader2, Check, X,
  RefreshCw, ArrowRight, AlertCircle, Sparkles, Shield,
} from "lucide-react";
import { cn } from "../lib/utils.js";

/**
 * Domains — your device's reachable address.
 *
 * Every device is served from a plan-provided subdomain (e.g.
 * myalias.servers.libreloom.org, or *.free.servers.libreloom.org on free).
 * You can choose your own subdomain, or put a custom domain (myserver.com) in
 * front of it. A custom domain overrides the subdomain while it's active.
 */
export default function Domains() {
  const { account } = useAuth();
  const queryClient = useQueryClient();
  const [customModal, setCustomModal] = useState(null); // null | { deviceId }
  const [error, setError] = useState("");

  const verified = !!account?.email_verified;

  const { data: devicesData, isLoading } = useQuery({
    queryKey: ["devices"],
    queryFn: api.getDevices,
    enabled: verified,
  });

  const devices = (devicesData?.devices || []).filter((d) => d.is_active);

  useEffect(() => {
    if (error) setError("");
  }, [error]);

  if (!verified) {
    return (
      <Layout>
        <div className="max-w-3xl mx-auto">
          <h2 className="font-mono text-2xl mb-6">Domain</h2>
          <Card><CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">Verify your email to manage domains.</p>
          </CardContent></Card>
        </div>
      </Layout>
    );
  }

  if (isLoading) {
    return (
      <Layout>
        <div className="max-w-3xl mx-auto">
          <h2 className="font-mono text-2xl mb-6">Domain</h2>
          <div className="flex items-center gap-3 py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            <p className="font-mono text-sm text-muted-foreground">Loading…</p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-mono text-2xl">Domain</h2>
          <Button variant="ghost" size="sm" onClick={() => {
            queryClient.invalidateQueries({ queryKey: ["devices"] });
            queryClient.invalidateQueries({ queryKey: ["domains"] });
          }}>
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed mb-8">
          The address people use to reach your server. Pick a hostname below, or
          bring your own domain — you're in control.
        </p>

        {error && (
          <div className="rounded-large-element bg-error/20 border border-error/30 px-4 py-3 mb-6">
            <p className="text-sm text-error">{error}</p>
          </div>
        )}

        <div className="space-y-8">
          {devices.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <div className="mx-auto w-14 h-14 rounded-full bg-accent flex items-center justify-center mb-6">
                  <Globe className="w-7 h-7 text-muted-foreground" />
                </div>
                <h3 className="font-mono text-xl mb-3">No active device</h3>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  Connect a device first to manage its domain.
                </p>
              </CardContent>
            </Card>
          ) : (
            devices.map((device) => (
              <DeviceDomain
                key={device.id}
                device={device}
                onCustomDomain={() => setCustomModal({ deviceId: device.id })}
              />
            ))
          )}
        </div>
      </div>

      {customModal && (
        <CustomDomainModal
          deviceId={customModal.deviceId}
          onClose={() => setCustomModal(null)}
        />
      )}
    </Layout>
  );
}

// ─── One device's domain control ────────────────────────────────────────────
function DeviceDomain({ device, onCustomDomain }) {
  const queryClient = useQueryClient();
  const {
    current_domain, subdomain_raw, subdomain_host,
    has_custom_domain, plan_domain, plan_name,
  } = device;

  const hasCustom = !!has_custom_domain;

  // The subdomain the device falls back to when no custom domain is active.
  // subdomain_raw is the user-chosen or device-derived prefix; subdomain_host
  // is the full hostname. Fall back gracefully if old shape.
  const subRaw = subdomain_raw || (subdomain_host || "").split(".")[0] || "";
  const subFull = subdomain_host || subdomain_raw || "";

  const switchSubMut = useMutation({
    mutationFn: api.useSubdomain,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });

  return (
    <Card className="relative overflow-hidden">
      <div className={cn("absolute inset-x-0 top-0 h-1", hasCustom ? "bg-success/60" : "bg-info/60")} />

      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="flex items-center gap-3">
          <div className={cn("w-11 h-11 rounded-pill flex items-center justify-center", hasCustom ? "bg-success/20 text-success" : "bg-info/20 text-info")}>
            {hasCustom ? <Shield className="w-5 h-5" /> : <LinkIcon className="w-5 h-5" />}
          </div>
          <div>
            <CardTitle className="font-mono text-lg">{current_domain}</CardTitle>
            <div className="flex items-center gap-2 mt-1.5">
              <Badge variant={hasCustom ? "success" : "info"}>
                {hasCustom ? "Custom domain" : "Plan subdomain"}
              </Badge>
              <span className="text-xs text-muted-foreground">{plan_name}</span>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* What's serving */}
        {hasCustom ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-mono text-foreground">{current_domain}</span> is what
            people reach you on. Your subdomain{" "}
            <span className="font-mono text-foreground">{subFull || subRaw}</span>{" "}
            takes over if you drop it.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            People reach this device at{" "}
            <span className="font-mono text-foreground">{subFull || current_domain}</span>.
          </p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <SubdomainEditor
            device={device}
            baseRaw={subRaw}
            planDomain={plan_domain}
          />

          <CustomDomainCard
            mode={hasCustom ? "has-custom" : "none"}
            onCustomDomain={onCustomDomain}
            onSwitchSub={() => switchSubMut.mutate(device.id)}
            switchingSub={switchSubMut.isPending}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Subdomain picker ───────────────────────────────────────────────────────
function SubdomainEditor({ device, baseRaw, planDomain }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(baseRaw || "");
  const [available, setAvailable] = useState(null); // null | true | false
  const [checking, setChecking] = useState(false);
  const debounceRef = useRef(null);

  // planDomain may look like "*.servers.libreloom.org" — build a friendly
  // suffix to show next to the editable prefix.
  const suffix = (planDomain || "").replace("*", "");

  const invalid = !/^[a-z0-9-]{3,63}$/.test(value) ||
    value.startsWith("-") || value.endsWith("-");

  // Debounced live availability check (dedupe).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!value || invalid || value === baseRaw) {
      setAvailable(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    setAvailable(null);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.checkSubdomain(value);
        setAvailable(!!res.available);
      } catch {
        setAvailable(null);
      } finally {
        setChecking(false);
      }
    }, 400);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, baseRaw]);

  const canSave = value && !invalid && available === true && value !== baseRaw;

  const saveMut = useMutation({
    mutationFn: () => api.setSubdomain(device.id, value),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });

  let statusIcon = null;
  let statusText = "";
  if (checking) { statusIcon = <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />; statusText = "Checking…"; }
  else if (invalid && value) { statusIcon = <X className="w-4 h-4 text-error" />; statusText = "Letters, numbers, dashes only (3-63 chars)."; }
  else if (value === baseRaw) { statusIcon = <Shield className="w-4 h-4 text-success" />; statusText = "This is your current subdomain."; }
  else if (available === true) { statusIcon = <Check className="w-4 h-4 text-success" />; statusText = "Available!"; }
  else if (available === false) { statusIcon = <AlertCircle className="w-4 h-4 text-error" />; statusText = "Already taken — try another."; }

  const fullPreview = value && !invalid ? `${value}${suffix}` : "";

  return (
    <div className="rounded-large-element border border-border p-5">
      <div className="flex items-center gap-2 text-sm font-medium mb-1">
        <LinkIcon className="w-4 h-4 text-muted-foreground" />
        Your subdomain
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Pick a name for your address. It must be unique across all devices.
      </p>

      <div className="flex items-stretch gap-2 rounded-pill border border-border bg-background px-3 py-1.5 focus-within:ring-2 focus-within:ring-ring">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value.toLowerCase())}
          placeholder="myalias"
          className="flex-1 bg-transparent outline-none font-mono text-sm py-1"
          spellCheck={false}
        />
        <span className="flex items-center font-mono text-xs text-muted-foreground truncate max-w-[40%]">
          {suffix}
        </span>
        <Button
          size="sm"
          variant="default"
          loading={saveMut.isPending}
          onClick={() => saveMut.mutate()}
          disabled={!canSave}
        >
          Set
        </Button>
      </div>

      {fullPreview && (
        <p className="mt-2 font-mono text-xs text-muted-foreground">→ {fullPreview}</p>
      )}

      {statusIcon && (
        <p className={cn("mt-2 flex items-center gap-1.5 text-xs", available === true ? "text-success" : available === false ? "text-error" : "text-muted-foreground")}>
          {statusIcon} {statusText}
        </p>
      )}
    </div>
  );
}

// ─── Custom domain card ─────────────────────────────────────────────────────
function CustomDomainCard({ mode, onCustomDomain, onSwitchSub, switchingSub }) {
  if (mode === "has-custom") {
    return (
      <div className="rounded-large-element border border-border p-5 flex flex-col">
        <div className="flex items-center gap-2 text-sm font-medium mb-1">
          <Globe className="w-4 h-4 text-muted-foreground" />
          Custom domain
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          You have a custom domain set. You can change it or go back to your
          subdomain at any time.
        </p>
        <div className="mt-auto flex flex-col gap-2">
          <Button variant="outline" size="sm" onClick={onCustomDomain}>
            Change custom domain
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onSwitchSub}
            loading={switchingSub}
            className="justify-center text-muted-foreground"
          >
            Switch to my subdomain
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-large-element border border-border p-5 flex flex-col">
      <div className="flex items-center gap-2 text-sm font-medium mb-1">
        <Globe className="w-4 h-4 text-muted-foreground" />
        Custom domain
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Bring your own branded domain. You pay exactly what we pay for it.
      </p>
      <div className="mt-auto">
        <Button variant="primary" size="sm" onClick={onCustomDomain}>
          Get a custom domain <ArrowRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

// ─── Custom domain search/register modal ────────────────────────────────────
function CustomDomainModal({ deviceId, onClose }) {
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
        prev.map((d) => d.name === domain ? { ...d, available: res.available || res.registrable, price: res.registration_cost } : d)
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
        // Navigate to the payment provider once the checkout session is ready.
        // eslint-disable-next-line react-hooks/immutability -- intentional full-page redirect to Stripe checkout
        window.location.href = res.checkout_url;
      } else {
        setSuccess(`${domain} registered successfully!`);
        setTimeout(() => onClose(), 1800);
      }
    } catch (err) {
      setError(err.message || "Could not register domain.");
    } finally {
      setPurchasing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-fade-in" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-large-element border border-border bg-card text-card-foreground shadow-[0_24px_64px_rgba(0,0,0,0.35)] p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-pill bg-accent flex items-center justify-center">
              <Globe className="w-5 h-5 text-muted-foreground" />
            </div>
            <div>
              <h3 className="font-mono text-lg">Custom domain</h3>
              <p className="text-sm text-muted-foreground">
                You pay exactly what we pay — no markup on registration.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {success ? (
          <div className="text-center py-10">
            <div className="mx-auto w-14 h-14 rounded-full bg-success/20 flex items-center justify-center mb-4">
              <Check className="w-7 h-7 text-success" />
            </div>
            <p className="font-mono text-sm">{success}</p>
          </div>
        ) : (
          <>
            <div className="flex gap-2 mb-4">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  placeholder="Search a domain…"
                  className="pl-9"
                  autoFocus
                />
              </div>
              <Button variant="outline" onClick={handleSearch} disabled={!query.trim()}>
                <Search className="w-4 h-4" /> Search
              </Button>
            </div>

            {error && <p className="text-sm text-error mb-4">{error}</p>}

            {results.length > 0 ? (
              <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
                {results.map((result) => {
                  const isChecked = result.available !== undefined;
                  return (
                    <div
                      key={result.name}
                      className={cn(
                        "flex items-center justify-between rounded-large-element border p-4 gap-3 transition-colors",
                        result.available ? "border-success/30 bg-success/5" : "border-border"
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-sm text-foreground">{result.name}</div>
                        {!isChecked && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            Click Check to see availability &amp; price.
                          </div>
                        )}
                        {isChecked && result.available && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            ${result.price || "—"}/year · register
                          </div>
                        )}
                      </div>
                      {isChecked ? (
                        result.available ? (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => handlePurchase(result.name)}
                            loading={purchasing}
                            disabled={purchasing}
                          >
                            {purchasing ? "Registering…" : "Register"}
                          </Button>
                        ) : (
                          <Badge variant="outline">Taken</Badge>
                        )
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => handleCheck(result.name)} disabled={checking === result.name}>
                          {checking === result.name ? <Loader2 className="w-3 h-3 animate-spin" /> : "Check"}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center text-sm text-muted-foreground py-8">
                Search for a domain to get started.
              </div>
            )}

            <div className="flex justify-between items-center mt-6">
              <p className="text-xs text-muted-foreground">
                Registration via Cloudflare Registrar at cost.
              </p>
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