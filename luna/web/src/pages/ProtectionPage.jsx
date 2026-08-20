import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";

export default function ProtectionPage() {
  const queryClient = useQueryClient();
  const [source, setSource] = useState("");
  const [folder, setFolder] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState(null);
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const protections = useQuery({ queryKey: ["protections"], queryFn: () => getJson("/api/v1/protections") });

  const create = useMutation({
    mutationFn: () => postJson("/api/v1/protections", { source_drive_id: source, source_path: folder, target_drive_id: target }),
    onSuccess: () => { setFolder(""); queryClient.invalidateQueries({ queryKey: ["protections"] }); },
    onError: (err) => setError(String(err)),
  });
  const run = useMutation({
    mutationFn: (id) => postJson(`/api/v1/protections/${id}/run`, {}),
    onError: (err) => setError(String(err)),
  });

  return (
    <Page title="Protect a folder" titleId="protect-title">
      <Card icon={ShieldCheck} title="A free second copy">
        <p className="text-primary text-sm">
          Choose a folder and a second drive. Luna keeps a copy there, always
          free. If you delete a file by accident, the protected copy keeps it.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Dropdown options={(drives.data || []).map((d) => ({ value: d.id, label: d.label }))} value={source} onChange={setSource} placeholder="Folder's drive" fullWidth />
          <input className="rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" placeholder="Folder path, e.g. family" value={folder} onChange={(e) => setFolder(e.target.value)} />
          <Dropdown options={(drives.data || []).map((d) => ({ value: d.id, label: d.label }))} value={target} onChange={setTarget} placeholder="Second drive" fullWidth />
        </div>
        {error && <PageNotice variant="error" className="mt-2">{error}</PageNotice>}
        <div className="mt-4">
          <Button variant="primary" loading={create.isPending} disabled={!source || !folder || !target} onClick={() => create.mutate()}>Protect this folder</Button>
        </div>
      </Card>

      <div className="grid gap-4 mt-6">
        {(protections.data || []).map((p) => (
          <Card key={p.id} padding={false} noPopIn noHeightAnim>
            <div className="flex items-center justify-between p-4">
              <div>
                <p className="text-primary font-mono text-sm">{p.source_drive}/{p.source_path}</p>
                <p className="text-accent text-xs mt-1">protected on drive {p.target_drive} · last run {p.last_run ? new Date(p.last_run * 1000).toLocaleString() : "never"}</p>
              </div>
              <Button size="sm" variant="outline" loading={run.isPending} onClick={() => run.mutate(p.id)}>Refresh now</Button>
            </div>
          </Card>
        ))}
        {(protections.data || []).length === 0 && (
          <EmptyState icon={ShieldCheck} title="Nothing protected yet" description="Pick a folder and a second drive above to keep a free backup copy." />
        )}
      </div>
    </Page>
  );
}
