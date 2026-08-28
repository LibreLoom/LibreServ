import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { stripeLooksConfigured } from "../billing/stripeConfig.js";
import { Button } from "../components/ui/button.jsx";
import { VerifyHumanCard } from "../components/VerifyHumanCard.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { useAuth } from "../context/AuthContext.jsx";

export default function OnboardingPage() {
  const { isAuthenticated, register, me } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState("path");
  const [path, setPath] = useState("official");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [ossCode, setOssCode] = useState("");
  const [hostname, setHostname] = useState("");
  const [setupSecret, setSetupSecret] = useState("");
  const [error, setError] = useState("");
  const [waitMsg, setWaitMsg] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (step !== "code" && step !== "name") return undefined;
    const t = setInterval(async () => {
      try {
        const s = await api("/api/v1/onboarding/session");
        setWaitMsg(s.message || "");
        if (s.status === "attached" && step === "code" && isAuthenticated) setStep("name");
      } catch {
        /* waiting room is optional until bind */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [step, isAuthenticated]);

  async function bindCode(value) {
    const s = await api("/api/v1/onboarding/bind", { method: "POST", body: JSON.stringify({ code: value }) });
    setWaitMsg(s.message || "");
    return s;
  }

  async function finishOssVerify(paymentMethodId) {
    const body = paymentMethodId
      ? JSON.stringify({ payment_method_id: paymentMethodId })
      : "{}";
    await api("/api/v1/account/verify-human", { method: "POST", body });
    const minted = await api("/api/v1/account/oss-token", { method: "POST", body: "{}" });
    setOssCode(minted.code);
    setWaitMsg(minted.message);
    setStep("oss-code");
  }

  async function afterOssAccount(account) {
    if (stripeLooksConfigured(account || me)) {
      setStep("card");
      return;
    }
    await finishOssVerify();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <Card className="w-full max-w-lg animate-pop-in bg-card text-card-foreground">
        <CardHeader>
          <CardTitle className="font-mono text-2xl">Set up Luna</CardTitle>
          <CardDescription>
            {step === "path" && "How did this Luna arrive?"}
            {step === "code" && "Type the device code."}
            {step === "account" && "Create your Luna Connect account."}
            {step === "card" && "A dollar to confirm this is a real person; it counts toward cloud backup if you turn it on."}
            {step === "name" && "This name is the address you type to open Luna when you are not at home."}
            {step === "copies" && "Optional cloud backup."}
            {step === "done" && "You can open Luna from away."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === "path" && (
            <>
              <Button className="w-full" onClick={() => { setPath("official"); setStep("code"); }}>I have a booklet</Button>
              <Button variant="outline" className="w-full" onClick={() => { setPath("oss"); setStep("account"); }}>I set this computer up myself</Button>
              <p className="text-sm text-muted-foreground">Stay on your home internet. Plug Luna into power and into your router or modem with the included RJ45 (ethernet) cable.</p>
            </>
          )}
          {step === "code" && (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setError("");
                setLoading(true);
                try {
                  await bindCode(code);
                  setStep(isAuthenticated ? "name" : "account");
                } catch (err) {
                  setError(err.message);
                } finally {
                  setLoading(false);
                }
              }}
            >
              <Label htmlFor="code">Device code from the booklet (HDMI shows the same if you lost the paper)</Label>
              <Input id="code" className="font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value)} />
              {waitMsg && <p className="text-sm text-foreground">{waitMsg}</p>}
              <Button type="submit" className="w-full" loading={loading}>Continue</Button>
            </form>
          )}
          {step === "account" && !isAuthenticated && (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setError("");
                setLoading(true);
                try {
                  const account = await register(email, password);
                  if (path === "oss") {
                    await afterOssAccount(account);
                  } else {
                    if (code) await bindCode(code);
                    await api("/api/v1/onboarding/attach-account", { method: "POST", body: "{}" });
                    setStep("name");
                  }
                } catch (err) {
                  setError(err.message);
                } finally {
                  setLoading(false);
                }
              }}
            >
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 12 characters, with a letter and a number" />
              <p className="text-sm text-muted-foreground">At least 12 characters, including a letter and a number. That is so a stolen password list is less likely to open this account.</p>
              <Button type="submit" className="w-full" loading={loading}>Create account</Button>
              <p className="text-sm text-muted-foreground">Already have an account? <Link className="underline" to="/login">Sign in</Link></p>
            </form>
          )}
          {step === "card" && (
            <VerifyHumanCard
              account={me}
              loading={loading}
              onConfirm={async (paymentMethodId) => {
                setError("");
                setLoading(true);
                try {
                  await finishOssVerify(paymentMethodId);
                } catch (err) {
                  setError(err.message);
                } finally {
                  setLoading(false);
                }
              }}
            />
          )}
          {step === "oss-code" && (
            <div className="space-y-3">
              <p className="font-mono text-3xl tracking-widest text-center">{ossCode}</p>
              <p className="text-sm text-foreground">On Luna, open the address on the screen and enter this code.</p>
              <Button className="w-full" onClick={async () => {
                try {
                  await bindCode(ossCode);
                  setStep("name");
                } catch (err) {
                  setError(err.message);
                }
              }}>I entered it on Luna</Button>
            </div>
          )}
          {step === "name" && (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                setError("");
                setLoading(true);
                try {
                  await api("/api/v1/onboarding/attach-account", { method: "POST", body: "{}" });
                  const created = await api("/api/v1/onboarding/name", { method: "POST", body: JSON.stringify({ subdomain: name }) });
                  setHostname(created.hostname);
                  setSetupSecret(created.setup_secret || "");
                  setStep("copies");
                } catch (err) {
                  setError(err.message);
                } finally {
                  setLoading(false);
                }
              }}
            >
              <Label htmlFor="name">Name for this Luna</Label>
              <Input id="name" className="font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="kitchen" />
              <p className="text-sm text-muted-foreground">People will open Luna at this address on phones and computers away from home. Use letters and numbers, at least 3 characters.</p>
              <p className="text-sm font-mono">{name ? `${name.toLowerCase()}.luna.servers.libreloom.org` : "kitchen.luna.servers.libreloom.org"}</p>
              {waitMsg && <p className="text-sm">{waitMsg}</p>}
              <Button type="submit" className="w-full" loading={loading} disabled={name.trim().length < 3}>Use this name</Button>
            </form>
          )}
          {step === "copies" && (
            <div className="space-y-3">
              <p className="text-sm text-foreground">Cloud backup costs $7 per terabyte each month, based on how much is stored. Not a flat $7 a month.</p>
              {stripeLooksConfigured(me) ? (
                <VerifyHumanCard
                  account={me}
                  loading={loading}
                  description="Add a payment card to turn on cloud backup. It costs $7 per terabyte each month."
                  buttonLabel="Turn on cloud backup"
                  onConfirm={async (paymentMethodId) => {
                    setError("");
                    setLoading(true);
                    try {
                      await api("/api/v1/onboarding/backups", {
                        method: "POST",
                        body: JSON.stringify({ enable: true, payment_method_id: paymentMethodId }),
                      });
                      setStep("done");
                    } catch (err) {
                      setError(err.message);
                    } finally {
                      setLoading(false);
                    }
                  }}
                />
              ) : (
                <Button className="w-full" onClick={async () => {
                  try {
                    await api("/api/v1/onboarding/backups", { method: "POST", body: JSON.stringify({ enable: true }) });
                    setStep("done");
                  } catch (err) {
                    setError(err.message);
                  }
                }}>Turn on cloud backup</Button>
              )}
              <Button variant="outline" className="w-full" onClick={() => setStep("done")}>Skip for now</Button>
            </div>
          )}
          {step === "done" && (
            <div className="space-y-3">
              <p className="text-sm text-foreground">Open Luna at:</p>
              <p className="font-mono text-lg break-all">{hostname}</p>
              <p className="text-sm text-foreground">
                The first time you visit that address, create your Luna login there. That login is separate from this Luna Connect account. Paste this one-time code when you create it so only you — the person who just finished setup here — can make that first account. People who only know the address cannot.
              </p>
              {setupSecret && (
                <p className="font-mono text-lg break-all rounded-large-element border border-border bg-background px-4 py-3 text-foreground">{setupSecret}</p>
              )}
              <p className="text-sm text-foreground">Write the code down. You type it once. Do not put it in the address bar.</p>
              <Button className="w-full" onClick={() => navigate("/")}>Done</Button>
            </div>
          )}
          {error && <p className="text-sm text-error">{error}</p>}
          {me && step !== "done" && <p className="text-xs text-muted-foreground">Signed in as {me.email}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
