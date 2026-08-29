import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api.js";
import { Copy, ExternalLink } from "lucide-react";

export default function LunaPage() {
  const { me } = useAuth();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState(null);
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api("/api/v1/account/devices")
      .then((d) => setDevices(d.devices || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function mintPairingToken() {
    setError("");
    setMinting(true);
    try {
      const minted = await api("/api/v1/account/pairing-token", { method: "POST", body: "{}" });
      setPairing(minted);
    } catch (err) {
      setError(err.message);
    } finally {
      setMinting(false);
    }
  }

  async function copyCode(text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy. Select the text and copy it yourself.");
    }
  }

  const activated = Boolean(me?.activated);

  return (
    <Layout>
      <h1 className="font-mono text-3xl mb-2">Away from home</h1>
      <p className="text-muted-foreground mb-8">
        Signed in as {me?.email}. Connect a Luna here so you can open it when you are not at home.
      </p>
      <Card className="animate-fade-in-up">
        <CardHeader>
          <CardTitle>Your Lunas</CardTitle>
          <CardDescription>
            Open Setup and type the device code from the booklet or from this site (same long format either way).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="font-mono text-sm text-muted-foreground animate-pulse">Loading your Lunas…</p>
          ) : devices.length === 0 ? (
            <div className="rounded-large-element border border-dashed border-border px-6 py-10 text-center space-y-3">
              <p className="font-mono text-sm">No Luna is connected yet.</p>
              {activated ? (
                <>
                  <p className="text-sm text-muted-foreground max-w-md mx-auto">
                    After a factory reset, get a new setup code here and enter it on Luna. You do not need a new booklet from support.
                  </p>
                  <Button loading={minting} onClick={mintPairingToken}>
                    Get a new setup code
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground max-w-md mx-auto">
                    Have the code from the booklet ready, then start setup. When Luna comes online on your home network, we finish pairing here.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2 justify-center">
                    <Button asChild>
                      <Link to="/onboarding">Start setup</Link>
                    </Button>
                    <Button variant="outline" asChild>
                      <Link to="/register">I set this computer up myself</Link>
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              <ul className="space-y-2">
                {devices.map((d) => (
                  <li
                    key={d.id}
                    className="rounded-large-element border border-border px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-sm break-all">{d.hostname}</p>
                      {d.name && <p className="text-xs text-muted-foreground mt-1">{d.name}</p>}
                      {d.setup_secret && (
                        <p className="text-sm text-foreground mt-2 leading-relaxed">
                          First Luna login still needs this one-time code:{" "}
                          <span className="font-mono break-all">{d.setup_secret}</span>
                          . Paste it when you create the first account on Luna. Do not put it in the address bar.
                        </p>
                      )}
                    </div>
                    <Button variant="secondary" size="sm" asChild>
                      <a href={`https://${d.hostname}`} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        Open
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button variant="outline" asChild>
                  <Link to="/onboarding">Connect another Luna</Link>
                </Button>
                {activated && (
                  <Button variant="outline" loading={minting} onClick={mintPairingToken}>
                    Get a new setup code
                  </Button>
                )}
              </div>
            </>
          )}
          {pairing?.code && (
            <div className="rounded-large-element bg-background text-foreground border border-border px-4 py-4 space-y-3">
              <p className="font-mono text-xl tracking-widest break-all">{pairing.code}</p>
              <p className="text-sm leading-relaxed">
                {pairing.message || "On Luna, open the address on the screen and enter this code."}
              </p>
              <Button variant="secondary" onClick={() => copyCode(pairing.code)}>
                <Copy className="h-4 w-4" />
                {copied ? "Copied" : "Copy code"}
              </Button>
            </div>
          )}
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    </Layout>
  );
}
