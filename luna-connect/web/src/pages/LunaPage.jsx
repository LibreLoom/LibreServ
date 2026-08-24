import { useEffect, useState } from "react";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api.js";

export default function LunaPage() {
  const { me } = useAuth();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/v1/account/devices")
      .then((d) => setDevices(d.devices || []))
      .catch((err) => setError(err.message));
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
            Open Setup to type the booklet code, or the short code if you set this computer up yourself.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Luna is connected yet.</p>
          ) : (
            <ul className="space-y-2">
              {devices.map((d) => (
                <li key={d.id} className="font-mono rounded-large-element border border-border px-4 py-3">
                  {d.hostname}
                </li>
              ))}
            </ul>
          )}
          <Button type="button" onClick={() => { window.location.href = "/onboarding"; }}>Start setup</Button>
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    </Layout>
  );
}
