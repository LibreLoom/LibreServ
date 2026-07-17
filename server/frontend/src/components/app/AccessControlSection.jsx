import { cn } from "@/lib/utils";
import { useState, useEffect, useCallback } from "react";
import {
  ShieldCheck,
  Users,
  User,
  UserPlus,
  Trash2,
  Lock,
  CheckCircle,
  XCircle,
  Loader2,
} from "lucide-react";
import Card from "../cards/Card";
import Toggle from "../common/Toggle";
import Dropdown from "../common/Dropdown";
import Button from "../ui/Button";
import api from "../../lib/api";
import { useToast } from "../../context/ToastContext";

/**
 * AccessControlSection — manages who can reach an app.
 *
 * Internal apps: SSO is auto-configured at install time. Shows connection
 * status + user access list. No credentials are ever shown to the user.
 *
 * External apps: optional restricted-access toggle (Caddy forward_auth) +
 * user access list.
 *
 * @param {object} props
 * @param {string} props.instanceId
 * @param {"internal"|"external"} props.accessModel
 * @param {string} props.appName
 */
export default function AccessControlSection({ instanceId, accessModel, appName }) {
  const toast = useToast();
  const isInternal = accessModel === "internal";

  const [oidcConfigured, setOidcConfigured] = useState(false);
  const [oidcLoading, setOidcLoading] = useState(false);

  const [restricted, setRestricted] = useState(false);
  const [restrictedLoading, setRestrictedLoading] = useState(false);

  const [accessList, setAccessList] = useState([]);
  const [accessLoading, setAccessLoading] = useState(false);
  const [allUsers, setAllUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState("");

  const loadOIDCStatus = useCallback(async () => {
    if (!isInternal) return;
    setOidcLoading(true);
    try {
      const res = await api(`/apps/${instanceId}/oidc`);
      const data = await res.json();
      setOidcConfigured(!!data.configured);
    } catch {
      setOidcConfigured(false);
    } finally {
      setOidcLoading(false);
    }
  }, [instanceId, isInternal]);

  const loadRestricted = useCallback(async () => {
    if (isInternal) return;
    setRestrictedLoading(true);
    try {
      const res = await api(`/apps/${instanceId}/oidc/restricted`);
      const data = await res.json();
      setRestricted(!!data.restricted_access);
    } catch {
      // default off
    } finally {
      setRestrictedLoading(false);
    }
  }, [instanceId, isInternal]);

  const loadAccess = useCallback(async () => {
    setAccessLoading(true);
    try {
      const res = await api(`/apps/${instanceId}/oidc/access`);
      const data = await res.json();
      setAccessList(Array.isArray(data) ? data : []);
    } catch {
      setAccessList([]);
    } finally {
      setAccessLoading(false);
    }
  }, [instanceId]);

  const loadUsers = useCallback(async () => {
    try {
      const res = await api("/users");
      const data = await res.json();
      setAllUsers(data.data || []);
    } catch {
      setAllUsers([]);
    }
  }, []);

  useEffect(() => {
    loadOIDCStatus();
    loadRestricted();
    loadAccess();
    loadUsers();
  }, [loadOIDCStatus, loadRestricted, loadAccess, loadUsers]);

  const handleToggleRestricted = async (checked) => {
    setRestricted(checked);
    try {
      await api(`/apps/${instanceId}/oidc/restricted`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restricted_access: checked }),
      });
      toast.success(checked ? "Restricted access enabled." : "Restricted access disabled.");
    } catch (err) {
      setRestricted(!checked);
      toast.error(err.message || "Could not update access setting.");
    }
  };

  const handleGrantAccess = async () => {
    if (!selectedUser) return;
    try {
      await api(`/apps/${instanceId}/oidc/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: selectedUser }),
      });
      toast.success("Access granted.");
      setSelectedUser("");
      loadAccess();
    } catch (err) {
      toast.error(err.message || "Could not grant access.");
    }
  };

  const handleRevokeAccess = async (userId) => {
    try {
      await api(`/apps/${instanceId}/oidc/access/${userId}`, { method: "DELETE" });
      toast.success("Access revoked.");
      loadAccess();
    } catch (err) {
      toast.error(err.message || "Could not revoke access.");
    }
  };

  const availableUsers = allUsers
    .filter((u) => !accessList.some((a) => a.user_id === u.id))
    .map((u) => ({
      value: u.id,
      label: `${u.username}${u.email ? ` (${u.email})` : ""}`,
    }));

  return (
    <section className={cn("mt-8")} data-slot="access-control-section">
      <Card className="bg-primary! text-secondary! border-2! border-secondary!">
        {/* Section header — matches AppDetailPage pattern */}
        <div className="flex items-center gap-2 mb-6">
          {isInternal ? (
            <ShieldCheck size={20} className="text-secondary/70" />
          ) : (
            <Lock size={20} className="text-secondary/70" />
          )}
          <h2 className="text-2xl font-mono font-normal">Access Control</h2>
        </div>

        <div className="space-y-6">
          {/* --- Internal: SSO status --- */}
          {isInternal && (
            <div className="space-y-4">
              <p className="text-sm text-secondary">
                {appName} signs in through LibreServ. Users sign in with their
                LibreServ username and password.
              </p>
              {oidcLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 size={24} className="animate-spin text-secondary/70" />
                </div>
              ) : oidcConfigured ? (
                <div className="flex items-start gap-3 p-4 rounded-large-element bg-success/20 border border-success/30">
                  <div className="p-2 rounded-full bg-success/20">
                    <CheckCircle size={18} className="text-success" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-secondary">
                      Connected — sign-in is ready
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 p-4 rounded-large-element bg-error/20 border border-error/30">
                  <div className="p-2 rounded-full bg-error/20">
                    <XCircle size={18} className="text-error" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-secondary">
                      Not connected — reinstall the app to set up sign-in.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* --- External: Restricted access toggle --- */}
          {!isInternal && (
            <div className="space-y-4">
              <p className="text-sm text-secondary">
                By default, anyone who can reach {appName}'s address can access
                it. Enable restricted access to require a LibreServ login — only
                users on the list below will get through.
              </p>
              <Toggle
                checked={restricted}
                onChange={handleToggleRestricted}
                disabled={restrictedLoading}
                label="Require LibreServ login"
                description="Only users on the access list can open this app."
                iconOn={Lock}
              />
            </div>
          )}

          {/* --- User access list (shared) --- */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Users size={20} className="text-secondary/70" />
              <h3 className="text-xl font-mono font-normal">
                {isInternal ? "Who can sign in" : "Who can access"}
              </h3>
            </div>

            {/* Grant access — matches Control section button pattern */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-[200px]">
                <Dropdown
                  options={availableUsers}
                  value={selectedUser}
                  onChange={(v) => setSelectedUser(v)}
                  placeholder="Select a user..."
                  fullWidth
                  bg="primary"
                />
              </div>
              <Button
                variant="secondary"
                surface="primary"
                size="lg"
                onClick={handleGrantAccess}
                disabled={!selectedUser}
              >
                <UserPlus size={18} />
                Grant access
              </Button>
            </div>

            {/* Access list — rounded-large-element rows, no dividers */}
            {accessLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 size={24} className="animate-spin text-secondary/70" />
              </div>
            ) : accessList.length === 0 ? (
              <div className="rounded-large-element bg-secondary/10 px-6 py-8 text-center">
                <Users size={28} className="text-accent mx-auto mb-2" />
                <p className="font-mono text-secondary mb-1">No users added yet</p>
                <p className="text-sm text-secondary/80 max-w-xs mx-auto">
                  {isInternal
                    ? "Add users above to control who can sign in to this app."
                    : "Add users above to control who can reach this app."}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {accessList.map((entry) => (
                  <div
                    key={entry.user_id}
                    className="flex items-center justify-between gap-3 p-3 rounded-large-element bg-secondary/10 hover:bg-secondary/20 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex items-center justify-center h-8 w-8 rounded-full bg-secondary/20 shrink-0">
                        <User size={14} className="text-accent" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-secondary truncate">
                          {entry.username}
                        </p>
                        {entry.email && (
                          <p className="text-sm text-secondary/80 truncate">
                            {entry.email}
                          </p>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      surface="primary"
                      onClick={() => handleRevokeAccess(entry.user_id)}
                      className="border-error/40 text-error hover:bg-error/10 hover:text-error shrink-0"
                    >
                      <Trash2 size={14} />
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}
