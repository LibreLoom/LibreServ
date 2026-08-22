import { useEffect, useState } from "react";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api.js";

export default function LunaPage() {
  const { me } = useAuth();
  const [devices, setDevices] = useState([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    const d = await api("/api/v1/account/devices");
    setDevices(d.devices || []);
  }

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  return (
    <Layout>
      <h1 className="font-mono text-3xl mb-2">Your Luna</h1>
      <p className="text-muted-foreground mb-8">Signed in as {me?.email}. Pair a Luna so phones can open it away from home.</p>
      <Card className="animate-fade-in-up">
        <CardHeader>
          <CardTitle>Paired devices</CardTitle>
          <CardDescription>
            On Luna, turn remote access on, then tap Get pairing code. Type that code here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Luna is paired yet.</p>
          ) : (
            <ul className="space-y-2">
              {devices.map((d) => (
                <li key={d.id} className="font-mono rounded-large-element border border-border px-4 py-3">
                  {d.hostname}
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-col sm:flex-row gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              setLoading(true);
              try {
                await api("/api/v1/account/pair", { method: "POST", body: JSON.stringify({ code }) });
                setCode("");
                await load();
              } catch (err) {
                setError(err.message);
              } finally {
                setLoading(false);
              }
            }}
          >
            <div className="flex-1">
              <Label htmlFor="pair">Pairing code from Luna</Label>
              <Input id="pair" className="uppercase" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABC123" />
            </div>
            <Button type="submit" className="sm:self-end" loading={loading}>Pair this Luna</Button>
          </form>
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    </Layout>
  );
}
