import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, UserPlus } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import Button from "../components/ui/Button";
import Pill from "../components/common/Pill";
import Dropdown from "../components/common/Dropdown";
import TextLink from "../components/ui/TextLink";
import { getDrives, getJson, postJson } from "../lib/api";
import { useAuth } from "../context/AuthContext";

async function del(path) {
  const res = await fetch(path, { method: "DELETE", credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Couldn't remove it");
  }
  return res.json();
}

export default function UsersPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  const users = useQuery({ queryKey: ["users"], queryFn: () => getJson("/api/v1/users"), enabled: user?.role === "admin" });
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const grants = useQuery({
    queryKey: ["grants"],
    queryFn: () => getJson("/api/v1/grants"),
    enabled: user?.role === "admin",
  });

  const createMutation = useMutation({
    mutationFn: (body) => postJson("/api/v1/users", body),
    onSuccess: () => { setCreating(false); queryClient.invalidateQueries({ queryKey: ["users"] }); },
    onError: (err) => setError(String(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: (id) => del(`/api/v1/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
    onError: (err) => setError(String(err)),
  });
  const grantMutation = useMutation({
    mutationFn: (body) => postJson("/api/v1/grants", body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grants"] }),
    onError: (err) => setError(String(err)),
  });
  const revokeMutation = useMutation({
    mutationFn: (id) => del(`/api/v1/grants/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["grants"] }),
    onError: (err) => setError(String(err)),
  });

  if (user?.role !== "admin") {
    return <Page title="People"><p className="text-secondary text-sm">Only an admin can manage people.</p></Page>;
  }

  return (
    <Page title="People" titleId="people-title" leftContent={<TextLink to="/">← Home</TextLink>}
      rightContent={<Button size="sm" variant="secondary" onClick={() => { setError(null); setCreating(true); }}><UserPlus size={14} /> Add person</Button>}
    >
      {error && <p className="text-error text-xs mb-4">{error}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {(users.data || []).map((u) => (
          <Card key={u.id} title={u.display_name} headerActions={<Pill variant={u.role === "admin" ? "info" : "success"}>{u.role}</Pill>}>
            <p className="text-primary text-sm font-mono">{u.username}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => { setSelected(u); setError(null); }}>Access</Button>
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

      {selected && (
        <ModalCard title={`Access for ${selected.display_name}`} onClose={() => setSelected(null)}>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {(grants.data || []).filter((g) => g.user_id === selected.id).map((g) => (
              <div key={g.id} className="flex items-center justify-between rounded-large-element border border-primary/20 p-3">
                <span className="text-primary text-xs font-mono">{g.drive_id}{g.path ? `/${g.path}` : " (whole drive)"} · {g.permission}</span>
                <Button size="iconSm" variant="danger" onClick={() => revokeMutation.mutate(g.id)}><Trash2 size={12} /></Button>
              </div>
            ))}
            {(grants.data || []).filter((g) => g.user_id === selected.id).length === 0 && (
              <p className="text-primary text-xs">No access yet.</p>
            )}
          </div>
          <GrantForm
            key={selected.id}
            drives={drives.data || []}
            onGrant={(grant) => grantMutation.mutate({ ...grant, user_id: selected.id })}
            busy={grantMutation.isPending}
          />
        </ModalCard>
      )}
    </Page>
  );
}

function CreateUserModal({ onClose, onSubmit, busy }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  return (
    <ModalCard title="Add a person" onClose={onClose}>
      <div className="space-y-3">
        <input className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" placeholder="Their name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <input className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="flex gap-3">
          <Button variant="secondary" loading={busy} onClick={() => onSubmit({ username, display_name: displayName, password, role: "user" })}>Add person</Button>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </ModalCard>
  );
}

function GrantForm({ drives, onGrant, busy }) {
  const [driveId, setDriveId] = useState("");
  const [path, setPath] = useState("");
  const [permission, setPermission] = useState("read");
  return (
    <div className="mt-4 border-t border-primary/10 pt-4 space-y-3">
      <p className="font-mono text-xs text-primary">Grant access</p>
      <Dropdown
        options={drives.map((d) => ({ value: d.id, label: d.label }))}
        value={driveId}
        onChange={setDriveId}
        placeholder="Choose a drive"
        fullWidth
      />
      <input className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" placeholder="Folder (leave empty for the whole drive)" value={path} onChange={(e) => setPath(e.target.value)} />
      <Dropdown options={[{ value: "read", label: "Can look" }, { value: "write", label: "Can add and change" }]} value={permission} onChange={setPermission} fullWidth />
      <Button variant="secondary" fullWidth loading={busy} disabled={!driveId} onClick={() => onGrant({ drive_id: driveId, path, permission })}>
        <Plus size={14} /> Grant access
      </Button>
    </div>
  );
}
