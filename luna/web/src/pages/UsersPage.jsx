import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, Trash2, User, UserPlus } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import ConfirmModal from "../components/cards/ConfirmModal";
import Button from "../components/ui/Button";
import Pill from "../components/common/Pill";
import Table from "../components/common/Table";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";
import { InfoHint } from "../components/ui/Tooltip";
import { apiErrorMessage, deleteJson, getJson, postJson } from "../lib/api";
import {
  PASSWORD_POLICY_HINT,
  meetsPasswordPolicy,
  passwordChecks,
  passwordPolicyError,
} from "../lib/passwordPolicy";
import { useAuth } from "../context/AuthContext";

export default function UsersPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const [userToDelete, setUserToDelete] = useState(null);

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => getJson("/api/v1/users"),
    enabled: user?.role === "admin",
  });

  const createMutation = useMutation({
    mutationFn: (body) => postJson("/api/v1/users", body),
    onSuccess: () => {
      setCreating(false);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => setError(apiErrorMessage(err, "Couldn't add this user. Try again.")),
  });
  const deleteMutation = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/users/${id}`),
    onSuccess: () => {
      setUserToDelete(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => {
      setUserToDelete(null);
      setError(apiErrorMessage(err, "Couldn't remove this user. Try again."));
    },
  });

  if (user?.role !== "admin") {
    return (
      <Page title="Users">
        <Card padding>
          <p className="text-primary text-sm">
            This page is for admins. Ask an admin if you need someone added or removed.
          </p>
        </Card>
      </Page>
    );
  }

  const list = users.data || [];
  const loading = users.isLoading;
  const showList = !loading && !users.isError && list.length > 0;
  const showEmpty = !loading && !users.isError && list.length === 0;

  return (
    <>
      <Page
        title="Users"
        titleId="users-title"
        className={userToDelete ? "pop-out" : "pop-in"}
        rightContent={
          <Button
            size="sm"
            variant="secondary"
            surface="primary"
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
          >
            <UserPlus size={14} aria-hidden="true" />
            Add user
          </Button>
        }
      >
        {error && (
          <PageNotice variant="error" className="mb-4">
            {error}
          </PageNotice>
        )}

        {users.isError && (
          <PageNotice variant="error" className="mb-4">
            {String(users.error?.message || "Couldn't load users. Try again.")}
          </PageNotice>
        )}

        {showEmpty && (
          <EmptyState
            className="mt-5"
            icon={User}
            title="No people yet"
            description="Add someone to share drives with."
            action={
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setError(null);
                  setCreating(true);
                }}
              >
                <UserPlus size={14} aria-hidden="true" />
                Add user
              </Button>
            }
          />
        )}

        {showList && (
          <section className="mt-5" aria-label="User list">
            <Card surface="primary" padding={false} className="overflow-hidden" noHeightAnim>
              <div className="overflow-x-auto">
                <Table
                  columns={[
                    {
                      key: "display_name",
                      label: "Name",
                      render: (row) => (
                        <span className="inline-flex items-center gap-2">
                          <span className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                            <User size={14} className="text-accent" aria-hidden="true" />
                          </span>
                          <span className="font-semibold text-sm text-primary">
                            {row.display_name || row.username}
                          </span>
                        </span>
                      ),
                    },
                    {
                      key: "username",
                      label: "Username",
                      render: (row) => (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-pill bg-primary/10 text-sm font-mono text-primary">
                          {row.username}
                        </span>
                      ),
                    },
                    {
                      key: "role",
                      label: "Role",
                      render: (row) =>
                        row.role === "admin" ? (
                          <span className="inline-flex items-center gap-1">
                            <Pill variant="accent">
                              <Shield size={12} className="mr-0.5" aria-hidden="true" />
                              Admin
                            </Pill>
                            <InfoHint
                              label="What Admin means"
                              content="An admin can add users, change settings, and manage this Luna."
                            />
                          </span>
                        ) : (
                          <Pill variant="default">
                            <Shield size={12} className="mr-0.5" aria-hidden="true" />
                            Member
                          </Pill>
                        ),
                    },
                    {
                      key: "actions",
                      label: "Actions",
                      align: "center",
                      srOnly: true,
                      width: "w-16",
                      noRowClick: true,
                      render: (row) => (
                        <span className="flex items-center justify-center">
                          <Button
                            variant="ghost"
                            size="iconSm"
                            surface="secondary"
                            disabled={row.id === user.id || deleteMutation.isPending}
                            onClick={() =>
                              setUserToDelete({
                                id: row.id,
                                name: row.display_name || row.username,
                              })
                            }
                            aria-label={`Remove ${row.display_name || row.username}`}
                          >
                            <Trash2 size={16} aria-hidden="true" />
                          </Button>
                        </span>
                      ),
                    },
                  ]}
                  data={list}
                  rowKey="id"
                />
              </div>
            </Card>
          </section>
        )}
      </Page>

      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onSubmit={(body) => createMutation.mutate(body)}
          busy={createMutation.isPending}
        />
      )}

      <ConfirmModal
        open={!!userToDelete}
        title="Remove user"
        message={`Remove "${userToDelete?.name}" from this Luna? They will lose access to shared drives.`}
        confirmLabel="Remove"
        variant="danger"
        icon={User}
        loading={deleteMutation.isPending}
        onConfirm={() => userToDelete && deleteMutation.mutate(userToDelete.id)}
        onClose={() => setUserToDelete(null)}
      />
    </>
  );
}

function CreateUserModal({ onClose, onSubmit, busy }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [touchedPassword, setTouchedPassword] = useState(false);

  const checks = passwordChecks(password);
  const passwordOk = meetsPasswordPolicy(password);
  const passwordError =
    touchedPassword || password.length > 0 ? passwordPolicyError(password) : null;
  const canSubmit =
    username.trim().length > 0 && passwordOk && !busy;

  return (
    <ModalCard title="Add a user" onClose={onClose}>
      {({ close }) => (
      <div className="space-y-3">
        <input
          className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
          placeholder="Their name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          autoComplete="name"
        />
        <input
          className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />
        <div>
          <input
            type="password"
            className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
            placeholder={PASSWORD_POLICY_HINT}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={() => setTouchedPassword(true)}
            autoComplete="new-password"
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? "add-user-password-hint" : undefined}
          />
          {password.length > 0 && (
            <div className="mt-2 px-1 flex flex-wrap gap-x-3 gap-y-1 text-xs font-mono">
              <span className={checks.hasLength ? "text-success" : "text-primary"}>
                {checks.hasLength ? "✓" : "·"} 12+ characters
              </span>
              <span className={checks.hasLetter ? "text-success" : "text-primary"}>
                {checks.hasLetter ? "✓" : "·"} a letter
              </span>
              <span className={checks.hasDigit ? "text-success" : "text-primary"}>
                {checks.hasDigit ? "✓" : "·"} a number
              </span>
            </div>
          )}
          {passwordError && (
            <p id="add-user-password-hint" className="mt-1.5 px-1 text-xs text-error" role="alert">
              {passwordError}
            </p>
          )}
        </div>
        <div className="flex gap-3">
          <Button
            variant="primary"
            loading={busy}
            disabled={!canSubmit}
            onClick={() => {
              if (!canSubmit) return;
              onSubmit({
                username: username.trim(),
                display_name: displayName.trim() || username.trim(),
                password,
                role: "user",
              });
            }}
          >
            Add user
          </Button>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
        </div>
      </div>
      )}
    </ModalCard>
  );
}
