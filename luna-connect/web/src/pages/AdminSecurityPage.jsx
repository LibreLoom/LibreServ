import { useEffect, useState } from "react";
import { AdminLayout } from "../components/AdminLayout.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Button } from "../components/ui/button.jsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.jsx";
import { Input } from "../components/ui/input.jsx";
import ShakeTarget from "../components/ui/shake-target.jsx";
import { Label } from "../components/ui/label.jsx";
import { adminApi, useAdminAuth } from "../context/AdminAuthContext.jsx";
import { KeyRound, Plus, Shield, Trash2, Users } from "lucide-react";

export default function AdminSecurityPage() {
  const { account, updateAccount } = useAdminAuth();
  const [secret, setSecret] = useState(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [message, setMessage] = useState("");
  const [pwd, setPwd] = useState({ current: "", next: "", confirm: "" });
  const [pwdError, setPwdError] = useState("");
  const [pwdSuccess, setPwdSuccess] = useState("");
  const [admins, setAdmins] = useState([]);
  const [adminsError, setAdminsError] = useState("");
  const [adminFormError, setAdminFormError] = useState("");
  const [showAdminForm, setShowAdminForm] = useState(false);
  const [newAdmin, setNewAdmin] = useState({ email: "", password: "", name: "" });
  const [busy, setBusy] = useState("");

  const loadAdmins = () =>
    adminApi("/admin/admins")
      .then((data) => setAdmins(data.admins || []))
      .catch((err) => setAdminsError(err.message));

  useEffect(() => {
    loadAdmins();
  }, []);

  const setup2FA = async () => {
    setBusy("2fa-setup");
    setMessage("");
    try {
      const data = await adminApi("/admin/2fa/setup", { method: "POST", body: "{}" });
      setSecret(data);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy("");
    }
  };

  const verify2FA = async () => {
    setBusy("2fa-verify");
    setMessage("");
    try {
      await adminApi("/admin/2fa/verify", {
        method: "POST",
        body: JSON.stringify({ code: verifyCode }),
      });
      setSecret(null);
      setVerifyCode("");
      setMessage("Two-factor authentication is on.");
      updateAccount({ has_2fa: true });
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy("");
    }
  };

  const verifyShake =
    message && secret && !account?.has_2fa ? message : null;

  const changePassword = async () => {
    setPwdError("");
    setPwdSuccess("");
    if (pwd.next !== pwd.confirm) {
      setPwdError("New passwords do not match.");
      return;
    }
    setBusy("password");
    try {
      await adminApi("/admin/password", {
        method: "POST",
        body: JSON.stringify({ current_password: pwd.current, new_password: pwd.next }),
      });
      setPwdSuccess("Password updated.");
      setPwd({ current: "", next: "", confirm: "" });
    } catch (err) {
      setPwdError(err.message);
    } finally {
      setBusy("");
    }
  };

  const createAdmin = async () => {
    setBusy("create-admin");
    setAdminsError("");
    setAdminFormError("");
    try {
      await adminApi("/admin/admins", {
        method: "POST",
        body: JSON.stringify(newAdmin),
      });
      setNewAdmin({ email: "", password: "", name: "" });
      setShowAdminForm(false);
      await loadAdmins();
    } catch (err) {
      setAdminFormError(err.message);
    } finally {
      setBusy("");
    }
  };

  const deactivateAdmin = async (id) => {
    if (!window.confirm("Deactivate this admin account?")) return;
    setBusy(`del-${id}`);
    setAdminsError("");
    try {
      await adminApi(`/admin/admins/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadAdmins();
    } catch (err) {
      setAdminsError(err.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <AdminLayout>
      <h2 className="font-mono text-2xl mb-6">Security</h2>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-4 w-4" /> Account
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="font-mono">{account?.email || "—"}</dd>
            </div>
            <div className="flex justify-between items-center gap-4">
              <dt className="text-muted-foreground">Two-factor authentication</dt>
              <dd>
                {account?.has_2fa ? (
                  <Badge variant="success">Enabled</Badge>
                ) : (
                  <Badge variant="outline">Disabled</Badge>
                )}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Change password
          </CardTitle>
          <CardDescription>Use at least 12 characters with a letter and a number.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 max-w-md">
          <div>
            <Label htmlFor="current-password">Current password</Label>
            <ShakeTarget shake={pwdError}>
              <Input
                id="current-password"
                type="password"
                value={pwd.current}
                onChange={(e) => setPwd({ ...pwd, current: e.target.value })}
              />
            </ShakeTarget>
          </div>
          <div>
            <Label htmlFor="new-password">New password</Label>
            <ShakeTarget shake={pwdError}>
              <Input
                id="new-password"
                type="password"
                value={pwd.next}
                onChange={(e) => setPwd({ ...pwd, next: e.target.value })}
              />
            </ShakeTarget>
          </div>
          <div>
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <ShakeTarget shake={pwdError}>
              <Input
                id="confirm-password"
                type="password"
                value={pwd.confirm}
                onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })}
              />
            </ShakeTarget>
          </div>
          {pwdError && <p className="text-sm text-error">{pwdError}</p>}
          {pwdSuccess && <p className="text-sm text-success">{pwdSuccess}</p>}
          <Button loading={busy === "password"} onClick={changePassword}>
            Update password
          </Button>
        </CardContent>
      </Card>

      {!account?.has_2fa && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Enable two-factor authentication</CardTitle>
            <CardDescription>
              Add a code from an authenticator app when you sign in. Keep the secret private.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!secret ? (
              <Button loading={busy === "2fa-setup"} onClick={setup2FA}>
                Create authenticator secret
              </Button>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Add this secret in your authenticator app, then enter the 6-digit code.
                </p>
                <p className="font-mono text-sm break-all rounded-large-element border border-border bg-background px-4 py-3">
                  {secret.secret}
                </p>
                <div className="max-w-xs">
                  <Label htmlFor="totp-verify">Authenticator code</Label>
                  <ShakeTarget shake={verifyShake}>
                    <Input
                      id="totp-verify"
                      value={verifyCode}
                      onChange={(e) => setVerifyCode(e.target.value)}
                      maxLength={6}
                      placeholder="000000"
                    />
                  </ShakeTarget>
                </div>
                <Button loading={busy === "2fa-verify"} onClick={verify2FA}>
                  Turn on 2FA
                </Button>
              </>
            )}
            {message && <p className="text-sm text-muted-foreground">{message}</p>}
          </CardContent>
        </Card>
      )}

      {account?.has_2fa && message && (
        <p className="mb-6 text-sm text-success">{message}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" /> Admin accounts
          </CardTitle>
          <CardDescription>People who can mint setup codes and manage this Connect.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {adminsError && <p className="text-sm text-error">{adminsError}</p>}
          <ul className="space-y-2">
            {admins.map((a) => (
              <li
                key={a.id}
                className="rounded-large-element border border-border px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-mono text-sm">{a.email}</p>
                  <p className="text-xs text-muted-foreground">{a.name || "No name"}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {a.has_2fa ? <Badge variant="success">2FA</Badge> : <Badge variant="outline">No 2FA</Badge>}
                  {a.is_active ? (
                    <Badge variant="success">Active</Badge>
                  ) : (
                    <Badge variant="destructive">Disabled</Badge>
                  )}
                  {a.is_active && a.id !== account?.id && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busy === `del-${a.id}`}
                      onClick={() => deactivateAdmin(a.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Deactivate
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {!showAdminForm ? (
            <Button variant="secondary" onClick={() => setShowAdminForm(true)}>
              <Plus className="h-4 w-4" />
              Add admin
            </Button>
          ) : (
            <div className="space-y-3 max-w-md rounded-large-element border border-border p-4">
              <div>
                <Label htmlFor="admin-name">Name</Label>
                <ShakeTarget shake={adminFormError}>
                  <Input
                    id="admin-name"
                    value={newAdmin.name}
                    onChange={(e) => setNewAdmin({ ...newAdmin, name: e.target.value })}
                  />
                </ShakeTarget>
              </div>
              <div>
                <Label htmlFor="admin-email">Email</Label>
                <ShakeTarget shake={adminFormError}>
                  <Input
                    id="admin-email"
                    type="email"
                    value={newAdmin.email}
                    onChange={(e) => setNewAdmin({ ...newAdmin, email: e.target.value })}
                  />
                </ShakeTarget>
              </div>
              <div>
                <Label htmlFor="admin-password">Password</Label>
                <ShakeTarget shake={adminFormError}>
                  <Input
                    id="admin-password"
                    type="password"
                    value={newAdmin.password}
                    onChange={(e) => setNewAdmin({ ...newAdmin, password: e.target.value })}
                    placeholder="At least 12 characters"
                  />
                </ShakeTarget>
              </div>
              {adminFormError && <p className="text-sm text-error">{adminFormError}</p>}
              <div className="flex gap-2">
                <Button loading={busy === "create-admin"} onClick={createAdmin}>
                  Create
                </Button>
                <Button variant="outline" onClick={() => setShowAdminForm(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </AdminLayout>
  );
}
