import { useState } from "react";
import { Layout } from "../components/Layout.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card.jsx";

export default function AdminTokensPage() {
  const [token, setToken] = useState("");
  const [admin, setAdmin] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  return (
    <Layout>
      <h1 className="font-mono text-3xl mb-2">New booklet code</h1>
      <p className="text-muted-foreground mb-8">
        Official setup codes are created here, then printed in the box. The public OS image has no code.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Factory token</CardTitle>
          <CardDescription>Paste the admin secret, then create a code to copy into the booklet.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <input
            className="w-full rounded-pill border border-border bg-background text-foreground px-4 py-2 font-mono"
            type="password"
            placeholder="Admin secret"
            value={admin}
            onChange={(e) => setAdmin(e.target.value)}
          />
          <Button
            onClick={async () => {
              setError("");
              try {
                const res = await fetch("/admin/setup-tokens", {
                  method: "POST",
                  headers: { Authorization: `Bearer ${admin}` },
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || "Could not create a code.");
                setResult(data.token);
                setToken(data.token);
              } catch (err) {
                setError(err.message);
              }
            }}
          >
            New token
          </Button>
          {result && (
            <p className="font-mono text-xl tracking-widest break-all">{token}</p>
          )}
          {error && <p className="text-sm text-error">{error}</p>}
        </CardContent>
      </Card>
    </Layout>
  );
}
