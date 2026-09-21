import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client.js";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/card.jsx";
import { Button } from "../components/ui/button.jsx";
import { Input } from "../components/ui/input.jsx";
import { Label } from "../components/ui/label.jsx";
import { Badge } from "../components/ui/badge.jsx";
import { Layout } from "../components/Layout.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { Shield, KeyRound, Users, Plus, Trash2 } from "lucide-react";

export default function Security() {
  const { account, updateAccount } = useAuth();
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [message, setMessage] = useState("");

  // Password change form
  const [pwd, setPwd] = useState({ current: "", next: "", confirm: "" });
  const [pwdError, setPwdError] = useState("");
  const [pwdSuccess, setPwdSuccess] = useState("");

  // New admin form
  const [newAdmin, setNewAdmin] = useState({ email: "", password: "", name: "" });
  const [showAdminForm, setShowAdminForm] = useState(false);

  // 2FA
  const setupMut = useMutation({
    mutationFn: api.setup2FA,
    onSuccess: (data) => { setSecret(data); setMessage(""); },
  });
  const verifyMut = useMutation({
    mutationFn: api.verify2FA,
    onSuccess: () => { setSecret(null); setVerifyCode(""); setMessage("2FA enabled successfully."); updateAccount({ has_2fa: true }); },
    onError: (err) => setMessage(err.message),
  });

  // Password change
  const pwdMut = useMutation({
    mutationFn: () => api.changePassword(pwd.current, pwd.next),
    onSuccess: () => {
      setPwdSuccess("Password updated successfully.");
      setPwdError("");
      setPwd({ current: "", next: "", confirm: "" });
    },
    onError: (err) => { setPwdError(err.message); setPwdSuccess(""); },
  });

  const handlePasswordSubmit = () => {
    setPwdError("");
    setPwdSuccess("");
    if (pwd.next !== pwd.confirm) {
      setPwdError("New passwords do not match.");
      return;
    }
    if (pwd.next.length < 12) {
      setPwdError("New password must be at least 12 characters.");
      return;
    }
    pwdMut.mutate();
  };

  // Admin management
  const { data: adminsData } = useQuery({
    queryKey: ["admins"],
    queryFn: api.listAdmins,
  });
  const admins = adminsData?.admins || [];

  const createAdminMut = useMutation({
    mutationFn: () => api.createAdmin(newAdmin.email, newAdmin.password, newAdmin.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admins"] });
      setNewAdmin({ email: "", password: "", name: "" });
      setShowAdminForm(false);
    },
  });
  const deleteAdminMut = useMutation({
    mutationFn: api.deleteAdmin,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admins"] }),
  });

  return (
    <Layout>
      <h2 className="font-mono text-2xl mb-6">Security</h2>

      {/* Account info */}
      <Card className="mb-6">
        <CardHeader><CardTitle className="flex items-center gap-2"><Shield className="h-4 w-4" /> Account</CardTitle></CardHeader>
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

      {/* Change password */}
      <Card className="mb-6">
        <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Change Password</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-4 max-w-md">
            <div>
              <Label htmlFor="current-pwd">Current Password</Label>
              <Input id="current-pwd" type="password" value={pwd.current} onChange={(e) => setPwd({ ...pwd, current: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="new-pwd">New Password</Label>
              <Input id="new-pwd" type="password" value={pwd.next} onChange={(e) => setPwd({ ...pwd, next: e.target.value })} />
              <p className="text-xs text-muted-foreground mt-1">At least 12 characters.</p>
            </div>
            <div>
              <Label htmlFor="confirm-pwd">Confirm New Password</Label>
              <Input id="confirm-pwd" type="password" value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })} />
            </div>
            {pwdError && <p className="text-sm text-destructive">{pwdError}</p>}
            {pwdSuccess && <p className="text-sm text-success">{pwdSuccess}</p>}
            <Button onClick={handlePasswordSubmit} loading={pwdMut.isPending} disabled={!pwd.current || !pwd.next || !pwd.confirm}>
              Update Password
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 2FA */}
      {!account?.has_2fa && (
        <Card className="mb-6">
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

      {/* Admin management */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" /> Admin Accounts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {admins.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <p className="font-mono text-sm">{a.email}</p>
                  <div className="flex gap-2 mt-1">
                    {a.has_2fa && <Badge variant="success">2FA</Badge>}
                    <Badge variant={a.is_active ? "default" : "outline"}>{a.is_active ? "Active" : "Disabled"}</Badge>
                  </div>
                </div>
                {a.id !== account?.id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    loading={deleteAdminMut.isPending}
                    onClick={() => deleteAdminMut.mutate(a.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>

          {showAdminForm ? (
            <div className="mt-4 space-y-3 max-w-md">
              <div>
                <Label htmlFor="admin-email">Email</Label>
                <Input id="admin-email" type="email" value={newAdmin.email} onChange={(e) => setNewAdmin({ ...newAdmin, email: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="admin-name">Name</Label>
                <Input id="admin-name" type="text" value={newAdmin.name} onChange={(e) => setNewAdmin({ ...newAdmin, name: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="admin-pwd">Password</Label>
                <Input id="admin-pwd" type="password" value={newAdmin.password} onChange={(e) => setNewAdmin({ ...newAdmin, password: e.target.value })} />
                <p className="text-xs text-muted-foreground mt-1">At least 12 characters.</p>
              </div>
              {createAdminMut.isError && <p className="text-sm text-destructive">{createAdminMut.error.message}</p>}
              <div className="flex gap-2">
                <Button onClick={() => createAdminMut.mutate()} loading={createAdminMut.isPending} disabled={!newAdmin.email || !newAdmin.password}>
                  Create Admin
                </Button>
                <Button variant="outline" onClick={() => { setShowAdminForm(false); setNewAdmin({ email: "", password: "", name: "" }); }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" className="mt-4" onClick={() => setShowAdminForm(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add Admin
            </Button>
          )}
        </CardContent>
      </Card>

      {message && <p className="mt-4 text-sm text-muted-foreground">{message}</p>}
    </Layout>
  );
}
