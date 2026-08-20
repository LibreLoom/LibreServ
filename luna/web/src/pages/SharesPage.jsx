import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Trash2 } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import Button from "../components/ui/Button";
import Dropdown from "../components/common/Dropdown";
import { getDrives, getJson, postJson } from "../lib/api";

async function del(path) {
  const res = await fetch(path, { method: "DELETE", credentials: "include" });
  if (!res.ok) throw new Error("Couldn't remove it");
  return res.json();
}

export default function SharesPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const shares = useQuery({ queryKey: ["shares"], queryFn: () => getJson("/api/v1/shares") });
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });

  const revoke = useMutation({
    mutationFn: (id) => del(`/api/v1/shares/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["shares"] }),
  });

  return (
    <Page title="Links" titleId="shares-title"
      rightContent={<Button size="sm" variant="secondary" onClick={() => { setError(null); setCreating(true); }}><Link2 size={14} /> Share something</Button>}
    >
      {error && <p className="text-error text-xs mb-4">{error}</p>}
      <div className="grid gap-4">
        {(shares.data || []).map((s) => (
          <Card key={s.id} padding={false} noPopIn noHeightAnim>
            <div className="flex items-center justify-between p-4">
              <div>
                <p className="text-primary font-mono text-sm">{s.drive_id}{s.path ? `/${s.path}` : ""}</p>
                <p className="text-accent text-xs mt-1">
                  {s.has_password ? "Password protected" : "Anyone with the link"} · {s.expires_at ? "expires" : "never expires"}
                </p>
              </div>
              <Button size="iconSm" variant="danger" onClick={() => revoke.mutate(s.id)}><Trash2 size={12} /></Button>
            </div>
          </Card>
        ))}
        {(shares.data || []).length === 0 && <p className="text-secondary text-sm">No links yet.</p>}
      </div>

      {creating && <CreateShareModal drives={drives.data || []} onClose={() => setCreating(false)} onError={setError} onDone={() => { setCreating(false); queryClient.invalidateQueries({ queryKey: ["shares"] }); }} />}
    </Page>
  );
}

function CreateShareModal({ drives, onClose, onError, onDone }) {
  const [driveId, setDriveId] = useState("");
  const [path, setPath] = useState("");
  const [password, setPassword] = useState("");
  const [days, setDays] = useState("30");
  const [result, setResult] = useState(null);
  const mutation = useMutation({
    mutationFn: (/** @type {any} */ body) => postJson("/api/v1/shares", body),
    onSuccess: (data) => setResult(data),
    onError: (err) => onError(String(err)),
  });

  if (result) {
    return (
      <ModalCard title="Link ready" onClose={onDone}>
        <p className="text-primary text-sm">Share this address:</p>
        <div className="mt-3 flex items-center gap-2">
          <input readOnly className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" value={window.location.origin + result.url} onFocus={(e) => e.target.select()} />
          <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(window.location.origin + result.url)}>Copy</Button>
        </div>
        <div className="mt-4 flex gap-3"><Button variant="outline" onClick={onDone}>Done</Button></div>
      </ModalCard>
    );
  }

  return (
    <ModalCard title="Share something" onClose={onClose}>
      <div className="space-y-3">
        <Dropdown options={drives.map((d) => ({ value: d.id, label: d.label }))} value={driveId} onChange={setDriveId} placeholder="Choose a drive" fullWidth />
        <input className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" placeholder="File or folder path, e.g. photos/summer" value={path} onChange={(e) => setPath(e.target.value)} />
        <input type="password" className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" placeholder="Password (optional)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Dropdown options={[{ value: "7", label: "Expires in 7 days" }, { value: "30", label: "Expires in 30 days" }, { value: "365", label: "Expires in a year" }, { value: "", label: "Never expires" }]} value={days} onChange={setDays} fullWidth />
        <Button variant="secondary" fullWidth loading={mutation.isPending} disabled={!driveId || !path} onClick={() => mutation.mutate({ drive_id: driveId, path, password: password || undefined, expires_in_days: days ? Number(days) : undefined })}>
          Create link
        </Button>
      </div>
    </ModalCard>
  );
}
