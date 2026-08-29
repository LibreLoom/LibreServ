import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api.js";
import { ExternalLink } from "lucide-react";

export default function LunaPage() {
  const { me } = useAuth();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/api/v1/account/devices")
      .then((d) => setDevices(d.devices || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

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
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Have the code from the booklet ready, then start setup. When Luna comes online on your home network, we finish pairing here.
              </p>
              <Button asChild>
                <Link to="/onboarding">Start setup</Link>
              </Button>
            </div>
          ) : (
            <>
              <ul className="space-y-2">
                {devices.map((d) => (
                  <li
                    key={d.id}
                    className="rounded-large-element border border-border px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <p className="font-mono text-sm break-all">{d.hostname}</p>
                      {d.name && <p className="text-xs text-muted-foreground mt-1">{d.name}</p>}
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
              <Button variant="outline" asChild>
                <Link to="/onboarding">Connect another Luna</Link>
              </Button>
            </>
          )}
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    </Layout>
  );
}
