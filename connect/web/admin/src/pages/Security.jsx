import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";
import { useAuth } from "../context/AuthContext.jsx";

export default function Security() {
  const { account } = useAuth();
  const [secret, setSecret] = useState(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [message, setMessage] = useState("");

  const setupMut = useMutation({
    mutationFn: api.setup2FA,
    onSuccess: (data) => { setSecret(data); setMessage(""); },
  });

  const verifyMut = useMutation({
    mutationFn: api.verify2FA,
    onSuccess: () => { setSecret(null); setVerifyCode(""); setMessage("2FA enabled successfully."); },
    onError: (err) => setMessage(err.message),
  });

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-6">Security</h2>

      <Card className="mb-6">
        <CardHeader><CardTitle>Account</CardTitle></CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="font-mono">{account?.email || "—"}</dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-muted-foreground">Two-Factor Auth</dt>
              <dd>{account?.has_2fa ? <Badge variant="success">Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {!account?.has_2fa && (
        <Card>
          <CardHeader><CardTitle>Enable Two-Factor Authentication</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              2FA adds an extra layer of security for admin access. Required for sensitive operations.
            </p>
            {!secret ? (
              <Button onClick={() => setupMut.mutate()} loading={setupMut.isPending}>Set Up 2FA</Button>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-border p-4">
                  <p className="text-sm text-muted-foreground mb-2">Scan this secret in your authenticator app:</p>
                  <p className="font-mono text-sm break-all">{secret.secret}</p>
                </div>
                <div>
                  <Label htmlFor="verify">Enter code from your app</Label>
                  <Input id="verify" type="text" value={verifyCode} onChange={(e) => setVerifyCode(e.target.value)} placeholder="000000" maxLength={6} />
                </div>
                <Button onClick={() => verifyMut.mutate(verifyCode)} loading={verifyMut.isPending} disabled={!verifyCode}>
                  Verify & Enable
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {message && <p className="mt-4 text-sm text-muted-foreground">{message}</p>}
    </Layout>
  );
}
