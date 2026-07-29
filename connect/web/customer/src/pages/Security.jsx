import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
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
  const [disableCode, setDisableCode] = useState("");
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

  const disableMut = useMutation({
    mutationFn: api.disable2FA,
    onSuccess: () => { setDisableCode(""); setMessage("2FA disabled."); },
    onError: (err) => setMessage(err.message),
  });

  const resendMut = useMutation({
    mutationFn: api.resendVerification,
  });

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-6">Security</h2>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="font-mono">{account?.email || "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="font-mono">{account?.name || "—"}</dd>
            </div>
            <div className="flex justify-between items-center">
              <dt className="text-muted-foreground">Email Verified</dt>
              <dd>{account?.email_verified ? <Badge variant="success">Verified</Badge> : <Badge variant="warning">Pending</Badge>}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {account && !account.email_verified && (
        <Card className="mb-6 border-warning/30">
          <CardHeader>
            <CardTitle>Verify Your Email</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              We sent a verification link to {account.email}. Click the link in the email to
              confirm your address. You need to verify your email before you can generate a
              license key and connect your device.
            </p>
            <Button
              onClick={() => resendMut.mutate()}
              loading={resendMut.isPending}
            >
              Resend Verification Email
            </Button>
            {resendMut.isSuccess && (
              <p className="mt-3 text-sm text-success animate-in fade-in duration-300">
                Verification email sent. Check your inbox (and spam folder).
              </p>
            )}
            {resendMut.isError && (
              <p className="mt-3 text-sm text-error">{resendMut.error?.message}</p>
            )}
          </CardContent>
        </Card>
      )}

      {!account?.has_2fa && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Enable Two-Factor Authentication</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              2FA adds an extra layer of security. When enabled, you'll need a code from your
              authenticator app (like Google Authenticator or Authy) each time you sign in.
            </p>
            {!secret ? (
              <Button onClick={() => setupMut.mutate()} loading={setupMut.isPending}>
                Set Up 2FA
              </Button>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-border p-4">
                  <p className="text-sm text-muted-foreground mb-2">Scan this secret in your authenticator app:</p>
                  <p className="font-mono text-sm break-all">{secret.secret}</p>
                  <p className="text-xs text-muted-foreground mt-2 break-all">{secret.uri}</p>
                </div>
                <div>
                  <Label htmlFor="verify">Enter code from your app</Label>
                  <Input
                    id="verify"
                    type="text"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                    placeholder="000000"
                    maxLength={6}
                  />
                </div>
                <Button
                  onClick={() => verifyMut.mutate(verifyCode)}
                  loading={verifyMut.isPending}
                  disabled={!verifyCode}
                >
                  Verify & Enable
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {account?.has_2fa && (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-destructive">Disable Two-Factor Authentication</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Disabling 2FA makes your account less secure. You'll need a current code from your
              authenticator app to confirm.
            </p>
            <div className="flex gap-2">
              <Input
                type="text"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                placeholder="000000"
                maxLength={6}
              />
              <Button
                variant="destructive"
                onClick={() => disableMut.mutate(disableCode)}
                loading={disableMut.isPending}
                disabled={!disableCode}
              >
                Disable
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {message && <p className="mt-4 text-sm text-muted-foreground">{message}</p>}
    </Layout>
  );
}
