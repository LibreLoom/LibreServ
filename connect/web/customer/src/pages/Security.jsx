import { useState } from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import ShakeTarget from "../components/ui/shake-target.jsx";
import { Label } from "../components/ui/label.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { AlertCircle, Check, MailCheck, ShieldCheck, ShieldOff } from "lucide-react";

/**
 * Security — account identity, email verification, and two-factor auth.
 */
export default function Security() {
  const { account } = useAuth();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [status, setStatus] = useState(null); // { tone: "success"|"error", text }

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["me"] });

  const setupMut = useMutation({
    mutationFn: api.setup2FA,
    onSuccess: (data) => { setSecret(data); setStatus(null); },
    onError: (err) => setStatus({ tone: "error", text: err.message }),
  });

  const verifyMut = useMutation({
    mutationFn: api.verify2FA,
    onSuccess: () => {
      setSecret(null);
      setVerifyCode("");
      setStatus({ tone: "success", text: "Two-factor authentication is on." });
      refresh();
    },
    onError: (err) => setStatus({ tone: "error", text: err.message }),
  });

  const disableMut = useMutation({
    mutationFn: api.disable2FA,
    onSuccess: () => {
      setDisableCode("");
      setStatus({ tone: "success", text: "Two-factor authentication is off." });
      refresh();
    },
    onError: (err) => setStatus({ tone: "error", text: err.message }),
  });

  const resendMut = useMutation({
    mutationFn: api.resendVerification,
    onSuccess: () => setStatus({ tone: "success", text: "Verification email sent — check your inbox and spam folder." }),
    onError: (err) => setStatus({ tone: "error", text: err.message }),
  });

  const verifyShake =
    status?.tone === "error" && secret ? status : null;
  const disableShake =
    status?.tone === "error" && account?.has_2fa ? status : null;

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <h1 className="font-mono text-xl mb-8">Security</h1>

        <div className="space-y-8">
          {/* Account identity */}
          <section>
            <SectionHeader label="Account" />
            <Card>
              <CardContent className="py-4">
                <dl className="space-y-2.5 text-sm">
                  <Row label="Email" value={<span className="font-mono">{account?.email || "—"}</span>} />
                  <Row label="Name" value={<span className="font-mono">{account?.name || "—"}</span>} />
                  <Row
                    label="Email status"
                    value={account?.email_verified
                      ? <Badge variant="success">Verified</Badge>
                      : <Badge variant="warning">Pending</Badge>}
                  />
                </dl>
              </CardContent>
            </Card>
          </section>

          {/* Email verification */}
          {account && !account.email_verified && (
            <section>
              <SectionHeader label="Verify your email" />
              <Card className="border-warning/30">
                <CardContent className="py-4 space-y-3">
                  <p className="text-sm text-muted-foreground">
                    We sent a verification link to{" "}
                    <span className="font-mono text-foreground">{account.email}</span>.
                    Verify it to unlock your dashboard, keys, and billing.
                  </p>
                  <Button onClick={() => resendMut.mutate()} loading={resendMut.isPending}>
                    <MailCheck className="w-4 h-4" /> Resend verification email
                  </Button>
                </CardContent>
              </Card>
            </section>
          )}

          {/* 2FA */}
          <section>
            <SectionHeader label="Two-factor authentication" />
            {!account?.has_2fa ? (
              <Card>
                <CardContent className="py-4 space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Require a code from your authenticator app (Google Authenticator,
                    Authy, 1Password) every time you sign in.
                  </p>
                  {!secret ? (
                    <Button onClick={() => setupMut.mutate()} loading={setupMut.isPending}>
                      <ShieldCheck className="w-4 h-4" /> Set up 2FA
                    </Button>
                  ) : (
                    <div className="space-y-4">
                      <div className="rounded-large-element border border-border p-4">
                        <p className="text-xs text-muted-foreground mb-1.5">Add this secret to your app:</p>
                        <p className="font-mono text-sm break-all">{secret.secret}</p>
                        {secret.uri && (
                          <p className="font-mono text-xs text-muted-foreground mt-2 break-all">{secret.uri}</p>
                        )}
                      </div>
                      <div className="space-y-1.5 max-w-[200px]">
                        <Label htmlFor="verify-2fa">Code from your app</Label>
                        <ShakeTarget shake={verifyShake}>
                          <Input
                            id="verify-2fa"
                            value={verifyCode}
                            onChange={(e) => setVerifyCode(e.target.value)}
                            placeholder="000000"
                            maxLength={6}
                            inputMode="numeric"
                            autoComplete="one-time-code"
                          />
                        </ShakeTarget>
                      </div>
                      <Button
                        onClick={() => verifyMut.mutate(verifyCode)}
                        loading={verifyMut.isPending}
                        disabled={verifyCode.length < 6}
                      >
                        Verify &amp; enable
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card className="border-destructive/30">
                <CardContent className="py-4 space-y-3">
                  <p className="text-sm text-muted-foreground">
                    2FA is on. Disabling it makes your account less secure — confirm
                    with a current code.
                  </p>
                  <div className="flex items-center gap-2">
                    <div className="space-y-1.5 w-[160px]">
                      <Label htmlFor="disable-2fa" className="sr-only">Current code</Label>
                      <ShakeTarget shake={disableShake}>
                        <Input
                          id="disable-2fa"
                          value={disableCode}
                          onChange={(e) => setDisableCode(e.target.value)}
                          placeholder="000000"
                          maxLength={6}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                        />
                      </ShakeTarget>
                    </div>
                    <Button
                      variant="destructive"
                      onClick={() => disableMut.mutate(disableCode)}
                      loading={disableMut.isPending}
                      disabled={disableCode.length < 6}
                    >
                      <ShieldOff className="w-4 h-4" /> Disable 2FA
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {status && <StatusLine status={status} />}
          </section>
        </div>
      </div>
    </Layout>
  );
}

function SectionHeader({ label }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground shrink-0">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function StatusLine({ status }) {
  const ok = status.tone === "success";
  return (
    <p className={`flex items-center gap-1.5 text-sm mt-3 ${ok ? "text-success" : "text-error"}`}>
      {ok ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
      {status.text}
    </p>
  );
}