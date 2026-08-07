import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Input } from "../components/ui/input.jsx";
import { Layout } from "../components/Layout.jsx";
import {
  Globe, Link as LinkIcon, Search, Loader2, Check, X,
  RefreshCw, ArrowRight, AlertCircle, Shield, ChevronDown,
} from "lucide-react";
import { cn } from "../lib/utils.js";

/**
 * Domain — the address people reach this server on.
 *
 * You can register custom domains through us (at cost) and assign them to a
 * device later. If you have a device connected, you can also rename its
 * built-in subdomain or switch between the subdomain and a custom domain.
 */
export default function Domains() {
  const { account } = useAuth();
  const queryClient = useQueryClient();
  const verified = !!account?.email_verified;

  const { data: devicesData, isLoading } = useQuery({
    queryKey: ["devices"],
    queryFn: api.getDevices,
    enabled: verified,
  });
  const { data: domainsData } = useQuery({
    queryKey: ["domains"],
    queryFn: api.getDomains,
    enabled: verified,
  });

  const devices = (devicesData?.devices || []).filter((d) => d.is_active);
  const ownedDomains = domainsData?.domains || [];
  // Domains the user owns that aren't the current serving domain — retiring,
  // grace, or payment-failed ones need a visible warning, never silence.
  const warningDomains = ownedDomains.filter((d) =>
    d.status === "grace" || d.status === "payment_failed");

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["devices"] });
    queryClient.invalidateQueries({ queryKey: ["domains"] });
  };

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-1.5">
          <h1 className="font-mono text-xl">Domain</h1>
          <Button variant="ghost" size="icon" onClick={refresh} aria-label="Refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mb-8 max-w-[60ch]">
          The address people reach this server on. Rename the built-in subdomain
          or bring your own domain — switch between them anytime.
        </p>

        {!verified ? (
          <Card><CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">Verify your email to manage domains.</p>
          </CardContent></Card>
        ) : isLoading ? (
          <DomainSkeleton />
        ) : (
          <div className="space-y-10">
            {devices.length > 0 ? (
              devices.map((device) => (
                <AddressControl key={device.id} device={device} />
              ))
            ) : (
              <Card><CardContent className="py-12 text-center">
                <Globe className="w-7 h-7 mx-auto mb-4 text-muted-foreground" />
                <h3 className="font-mono text-base mb-2">No device connected yet</h3>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  Register a domain now and assign it to a device later.
                </p>
              </CardContent></Card>
            )}

            {/* The per-device section covers registration when a device exists;
                standalone is only needed before any device is connected. */}
            <DomainList domains={ownedDomains} />
            {devices.length === 0 && <CustomDomainRegistration />}

            {warningDomains.length > 0 && <DomainWarnings domains={warningDomains} />}
          </div>
        )}
      </div>
    </Layout>
  );
}

// ─── Owned domain list ─────────────────────────────────────────────────────
function DomainList({ domains }) {
  const active = domains.filter((d) => d.status === "active");
  const other = domains.filter((d) => d.status !== "active" && d.status !== "grace" && d.status !== "payment_failed");

  if (domains.length === 0) return null;

  return (
    <section className="space-y-3">
      <Divider label="Your domains" />
      <ul className="divide-y divide-border rounded-large-element border border-border overflow-hidden">
        {active.map((d) => (
          <DomainRow key={d.id} domain={d} />
        ))}
        {other.map((d) => (
          <DomainRow key={d.id} domain={d} />
        ))}
      </ul>
    </section>
  );
}

function DomainRow({ domain: d }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="font-mono text-sm truncate">{d.domain}</div>
        {d.device_id && (
          <div className="text-xs text-muted-foreground mt-0.5">
            Assigned to device
          </div>
        )}
        {!d.device_id && (
          <div className="text-xs text-muted-foreground mt-0.5">
            Not assigned to a device yet
          </div>
        )}
      </div>
      <Badge variant={d.status === "active" ? "success" : "outline"}>
        {d.status}
      </Badge>
    </li>
  );
}

// ─── Warnings for owned domains that are retiring or failing ───────────────
// A custom domain in grace stops working on its expiry date (it stopped
// renewing when the plan changed); a payment_failed domain is one failed
// charge away from lapsing. Never let these pass silently.
function DomainWarnings({ domains }) {
  return (
    <section className="space-y-3">
      <Divider label="Needs attention" />
      <ul className="space-y-3">
        {domains.map((d) => (
          <DomainWarningCard key={d.id} domain={d} />
        ))}
      </ul>
    </section>
  );
}

function DomainWarningCard({ domain: d }) {
  const stop = d.grace_until || d.expires_at;
  const stopDate = stop ? new Date(stop).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : null;
  const isPaymentFailed = d.status === "payment_failed";

  return (
    <Card className={isPaymentFailed ? "border-error/40" : "border-warning/40"}>
      <CardContent className="py-4 flex items-start gap-3">
        <AlertCircle className={isPaymentFailed ? "w-5 h-5 text-error shrink-0 mt-0.5" : "w-5 h-5 text-warning shrink-0 mt-0.5"} />
        <div className="min-w-0">
          <p className="font-mono text-sm">{d.domain}</p>
          {isPaymentFailed ? (
            <p className="text-sm text-error mt-1">
              The last renewal charge failed. Top up your credit in Billing or this
              domain will stop working{stopDate ? ` on ${stopDate}` : ""}.
            </p>
          ) : (
            <p className="text-sm text-warning mt-1">
              This domain will stop working{stopDate ? ` on ${stopDate}` : ""} — it
              stopped renewing when your plan changed. Reactivate a paid plan to
              keep it, or it releases when it expires.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function DomainSkeleton() {
  return (
    <div className="space-y-10 animate-pulse">
      <div className="space-y-3">
        <div className="h-3 w-20 rounded bg-accent" />
        <div className="h-8 w-72 rounded bg-accent" />
      </div>
      <div className="space-y-3">
        <div className="h-3 w-28 rounded bg-accent" />
        <div className="h-10 w-full rounded-pill bg-accent" />
        <div className="h-10 w-40 rounded-pill bg-accent" />
      </div>
    </div>
  );
}

// ─── The whole address control for one device ───────────────────────────────
function AddressControl({ device }) {
  const queryClient = useQueryClient();
  const {
    current_domain, subdomain_raw, subdomain_host,
    has_custom_domain, plan_domain, plan_name,
  } = device;

  const hasCustom = !!has_custom_domain;
  const subRaw = subdomain_raw || (subdomain_host || "").split(".")[0] || "";
  const subFull = subdomain_host || subdomain_raw || current_domain || "";
  const suffix = (plan_domain || "").replace("*", "");

  const switchSubMut = useMutation({
    mutationFn: api.useSubdomain,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["devices"] }),
  });

  return (
    <div className="space-y-8">
      {/* Current address — the answer to "what is my domain?" */}
      <section>
        <p className="text-xs text-muted-foreground mb-2">Current address</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Globe className="w-5 h-5 text-muted-foreground shrink-0" />
          <span className="font-mono text-2xl leading-none tracking-tight break-all">
            {current_domain}
          </span>
          <Badge variant={hasCustom ? "success" : "info"}>
            {hasCustom ? "Custom domain" : "Subdomain"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-2">{plan_name} plan</p>
      </section>

      <Divider label={hasCustom ? "Your custom domain" : "Your subdomain"} />

      {hasCustom ? (
        <CustomActive
          device={device}
          subFull={subFull}
          onSwitchSub={() => switchSubMut.mutate(device.id)}
          switchingSub={switchSubMut.isPending}
        />
      ) : (
        <SubdomainEditor
          device={device}
          baseRaw={subRaw}
          suffix={suffix}
        />
      )}

      <CustomDomainSection device={device} hasCustom={hasCustom} />
    </div>
  );
}

function Divider({ label }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground shrink-0">
        {label}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

// ─── Rename the subdomain ───────────────────────────────────────────────────
function SubdomainEditor({ device, baseRaw, suffix }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(baseRaw || "");
  const [available, setAvailable] = useState(null); // null | true | false
  const [checking, setChecking] = useState(false);
  const debounceRef = useRef(null);

  const invalid = !/^[a-z0-9-]{3,63}$/.test(value) ||
    value.startsWith("-") || value.endsWith("-");

  useEffect(() => {
    clearTimeout(debounceRef.current);
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["devices"] }),
  });

  let status = null;
  if (checking) {
    status = { icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />, text: "Checking availability…", tone: "text-muted-foreground" };
  } else if (invalid && value) {
    status = { icon: <X className="w-3.5 h-3.5" />, text: "Letters, numbers, dashes only (3–63 chars, no leading/trailing dash).", tone: "text-error" };
  } else if (value === baseRaw) {
    status = { icon: <Shield className="w-3.5 h-3.5" />, text: "This is your current name.", tone: "text-success" };
  } else if (available === true) {
    status = { icon: <Check className="w-3.5 h-3.5" />, text: "Available.", tone: "text-success" };
  } else if (available === false) {
    status = { icon: <AlertCircle className="w-3.5 h-3.5" />, text: "Already taken — try another.", tone: "text-error" };
  }

  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Rename the built-in address. It must be unique across all devices.
      </p>

      <div className="flex items-center gap-0">
        <Input
          id="subdomain-name"
          value={value}
          onChange={(e) => setValue(e.target.value.toLowerCase())}
          placeholder="myalias"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid || available === false || undefined}
          className="rounded-r-none border-r-0 max-w-[55%]"
        />
        <span
          className="flex h-10 items-center rounded-r-pill border border-l-0 border-input bg-accent/40 px-3 font-mono text-sm text-muted-foreground whitespace-nowrap"
          aria-hidden="true"
        >
          {suffix}
        </span>
      </div>

      {status && (
        <p className={cn("flex items-center gap-1.5 text-xs", status.tone)}>
          {status.icon} {status.text}
        </p>
      )}

      <Button
        size="md"
        loading={saveMut.isPending}
        onClick={() => saveMut.mutate()}
        disabled={!canSave}
      >
        Save name
      </Button>
    </section>
  );
}

// ─── Active custom domain: summary + actions ────────────────────────────────
function CustomActive({ subFull, onSwitchSub, switchingSub }) {
  return (
    <section className="space-y-3">
      <p className="text-sm text-muted-foreground">
        This device is fronted by the custom domain above. It takes over from
        your subdomain (<span className="font-mono">{subFull}</span>), which resumes
        if you switch back.
      </p>
      <Button
        variant="ghost"
        size="md"
        onClick={onSwitchSub}
        loading={switchingSub}
        className="text-muted-foreground"
      >
        Switch back to subdomain
      </Button>
    </section>
  );
}

// ─── Custom domain: inline search / register / change ───────────────────────
function CustomDomainSection({ device, hasCustom }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [checking, setChecking] = useState(null);
  const [purchasing, setPurchasing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Always show the section when there's no custom domain (it's the only
  // alternative). When a custom domain is active, collapse it behind a toggle.
  const visible = !hasCustom || open;

  const search = async () => {
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

  const check = async (name) => {
    setChecking(name);
    setError("");
    try {
      const res = await api.checkDomain(name);
      setResults((prev) =>
        prev.map((d) => d.name === name ? { ...d, available: res.available || res.registrable, price: res.registration_cost } : d)
      );
    } catch (err) {
      setError(err.message || "Could not check availability.");
    } finally {
      setChecking(null);
    }
  };

  const purchase = async (name) => {
    setPurchasing(true);
    setError("");
    try {
      const res = await api.registerDomain(device.id, name);
      if (res.checkout_url) {
        // eslint-disable-next-line react-hooks/immutability -- intentional full-page redirect to checkout
        window.location.href = res.checkout_url;
      } else {
        setSuccess(`${name} registered.`);
        setResults([]);
      }
    } catch (err) {
      setError(err.message || "Could not register domain.");
    } finally {
      setPurchasing(false);
    }
  };

  return (
    <>
      <Divider label="Custom domain" />
      <section className="space-y-3">
        {!visible ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown className="w-4 h-4" />
            Change to a different custom domain
          </button>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Register a domain through us and it routes here. You pay exactly
              what we pay at the registrar — no markup.
            </p>

            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
                placeholder="Search a name…"
                autoComplete="off"
                spellCheck={false}
              />
              <Button variant="outline" size="md" onClick={search} disabled={!query.trim()}>
                <Search className="w-4 h-4" />
              </Button>
            </div>

            {error && (
              <p className="flex items-center gap-1.5 text-xs text-error">
                <AlertCircle className="w-3.5 h-3.5" /> {error}
              </p>
            )}
            {success && (
              <p className="flex items-center gap-1.5 text-xs text-success">
                <Check className="w-3.5 h-3.5" /> {success}
              </p>
            )}

            {results.length > 0 && (
              <ul className="divide-y divide-border rounded-large-element border border-border overflow-hidden">
                {results.map((r) => {
                  const isChecked = r.available !== undefined;
                  return (
                    <li
                      key={r.name}
                      className="flex items-center justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="font-mono text-sm truncate">{r.name}</div>
                        {isChecked && r.available && (
                          <div className="text-xs text-muted-foreground">
                            ${r.price || "—"}/year
                          </div>
                        )}
                      </div>
                      {isChecked ? (
                        r.available ? (
                          <Button
                            size="sm"
                            onClick={() => purchase(r.name)}
                            loading={purchasing}
                            disabled={purchasing}
                          >
                            Register
                          </Button>
                        ) : (
                          <Badge variant="outline">Taken</Badge>
                        )
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => check(r.name)}
                          disabled={checking === r.name}
                        >
                          {checking === r.name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Check"}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>
    </>
  );
}

// ─── Standalone custom domain registration (no device needed) ───────────────
function CustomDomainRegistration() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [checking, setChecking] = useState(null);
  const [purchasing, setPurchasing] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const search = async () => {
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

  const check = async (name) => {
    setChecking(name);
    setError("");
    try {
      const res = await api.checkDomain(name);
      setResults((prev) =>
        prev.map((d) => d.name === name ? { ...d, available: res.available || res.registrable, price: res.registration_cost } : d)
      );
    } catch (err) {
      setError(err.message || "Could not check availability.");
    } finally {
      setChecking(null);
    }
  };

  const purchase = async (name) => {
    setPurchasing(true);
    setError("");
    try {
      // Register without a device_id — the domain is owned at the account level.
      const res = await api.registerDomain("", name);
      if (res.checkout_url) {
        // eslint-disable-next-line react-hooks/immutability -- intentional full-page redirect to checkout
        window.location.href = res.checkout_url;
      } else {
        setSuccess(`${name} registered.`);
        setResults([]);
      }
    } catch (err) {
      setError(err.message || "Could not register domain.");
    } finally {
      setPurchasing(false);
    }
  };

  return (
    <section className="space-y-3">
      <Divider label="Register a domain" />
      <p className="text-sm text-muted-foreground">
        Own a domain before you connect a device. Register one now, and assign it
        to your device once it's set up. You pay exactly what we pay at the
        registrar — no markup.
      </p>

      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Search a name…"
          autoComplete="off"
          spellCheck={false}
        />
        <Button variant="outline" size="md" onClick={search} disabled={!query.trim()}>
          <Search className="w-4 h-4" />
        </Button>
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-xs text-error">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </p>
      )}
      {success && (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <Check className="w-3.5 h-3.5" /> {success}
        </p>
      )}

      {results.length > 0 && (
        <ul className="divide-y divide-border rounded-large-element border border-border overflow-hidden">
          {results.map((r) => {
            const isChecked = r.available !== undefined;
            return (
              <li
                key={r.name}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="font-mono text-sm truncate">{r.name}</div>
                  {isChecked && r.available && (
                    <div className="text-xs text-muted-foreground">
                      ${r.price || "—"}/year
                    </div>
                  )}
                </div>
                {isChecked ? (
                  r.available ? (
                    <Button
                      size="sm"
                      onClick={() => purchase(r.name)}
                      loading={purchasing}
                      disabled={purchasing}
                    >
                      Register
                    </Button>
                  ) : (
                    <Badge variant="outline">Taken</Badge>
                  )
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => check(r.name)}
                    disabled={checking === r.name}
                  >
                    {checking === r.name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Check"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}