import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, UserPlus } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import Button from "../components/ui/Button";
import Pill from "../components/common/Pill";
import PageNotice from "../components/common/PageNotice";
import { InfoHint } from "../components/ui/Tooltip";
import { getJson, postJson } from "../lib/api";
import { useAuth } from "../context/AuthContext";

async function del(path) {
  const res = await fetch(path, { method: "DELETE", credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Couldn't remove this user. Try again.");
  }
  return res.json();
}

export default function UsersPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const users = useQuery({ queryKey: ["users"], queryFn: () => getJson("/api/v1/users"), enabled: user?.role === "admin" });

  const createMutation = useMutation({
    mutationFn: (body) => postJson("/api/v1/users", body),
    onSuccess: () => {
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => setError(String(err.message || err)),
  });
  const deleteMutation = useMutation({
    mutationFn: (id) => del(`/api/v1/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
    onError: (err) => setError(String(err)),
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

  return (
    <Page title="Users" titleId="users-title"
      rightContent={<Button size="sm" variant="primary" onClick={() => { setError(null); setCreating(true); }}><UserPlus size={14} /> Add user</Button>}
    >
      {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
      <div className="grid gap-4 md:grid-cols-2">
        {(users.data || []).map((u) => (
          <Card key={u.id} title={u.display_name} headerActions={
            u.role === "admin" ? (
              <span className="inline-flex items-center gap-1">
                <Pill variant="info">Admin</Pill>
                <InfoHint
                  label="What Admin means"
                  content="An admin can add users, change settings, and manage this Luna."
                />
              </span>
            ) : (
              <Pill variant="success">Member</Pill>
            )
          }>
            <p className="text-primary text-sm font-mono">{u.username}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="danger" disabled={u.id === user.id} onClick={() => deleteMutation.mutate(u.id)}>
                <Trash2 size={12} /> Remove
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onSubmit={(body) => createMutation.mutate(body)}
          busy={createMutation.isPending}
        />
      )}
    </Page>
  );
}

function CreateUserModal({ onClose, onSubmit, busy }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  return (
    <ModalCard title="Add a user" onClose={onClose}>
      <div className="space-y-3">
        <input className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" placeholder="Their name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <input className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="flex gap-3">
          <Button variant="primary" loading={busy} onClick={() => onSubmit({ username, display_name: displayName, password, role: "user" })}>Add user</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </ModalCard>
  );
}
