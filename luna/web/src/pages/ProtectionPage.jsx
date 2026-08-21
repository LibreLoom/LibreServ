import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";
import Dropdown from "../components/common/Dropdown";
import { getDrives, getJson, postJson, deleteJson, apiErrorMessage } from "../lib/api";

function driveName(drives, id) {
  return (drives || []).find((d) => d.id === id)?.label || id;
}

export default function ProtectionPage() {
  const queryClient = useQueryClient();
  const [source, setSource] = useState("");
  const [folder, setFolder] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState(null);
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const protections = useQuery({ queryKey: ["protections"], queryFn: () => getJson("/api/v1/protections") });
  const driveList = drives.data || [];

  const create = useMutation({
    mutationFn: () => postJson("/api/v1/protections", { source_drive_id: source, source_path: folder, target_drive_id: target }),
    onSuccess: () => { setFolder(""); queryClient.invalidateQueries({ queryKey: ["protections"] }); setError(null); },
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const run = useMutation({
    mutationFn: (id) => postJson(`/api/v1/protections/${id}/run`, {}),
    onError: (err) => setError(apiErrorMessage(err)),
  });
  const stop = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/protections/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["protections"] }),
    onError: (err) => setError(apiErrorMessage(err)),
  });

  const tooFewDrives = driveList.length < 2;

  return (
    <Page
      title="Protect a folder"
      titleId="protect-title"
      bottomContent={<p className="text-sm">This keeps a second copy on another drive. If you delete a file by accident, the copy stays.</p>}
    >
      <Card icon={ShieldCheck} title="A free second copy">
        {tooFewDrives ? (
          <>
            <p className="text-primary text-sm">
              You need two drives plugged in: one with the folder, and another for the copy.
              Add a second drive on Drives first.
            </p>
            <div className="mt-4">
              <Button variant="primary" asChild>
                <Link to="/drives">Go to Drives</Link>
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-primary text-sm">
              Choose the folder to keep safe, then a different drive for the copy.
              Type the folder the way it looks on Files — for example family.
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <Dropdown options={driveList.map((d) => ({ value: d.id, label: d.label }))} value={source} onChange={setSource} placeholder="Folder's drive" fullWidth />
              <input className="rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm" placeholder="Folder path, e.g. family" value={folder} onChange={(e) => setFolder(e.target.value)} />
              <Dropdown options={driveList.filter((d) => d.id !== source).map((d) => ({ value: d.id, label: d.label }))} value={target} onChange={setTarget} placeholder="Second drive" fullWidth />
            </div>
            {error && <PageNotice variant="error" className="mt-2">{error}</PageNotice>}
            <div className="mt-4">
              <Button variant="primary" loading={create.isPending} disabled={!source || !folder || !target || source === target} onClick={() => create.mutate()}>Protect this folder</Button>
            </div>
          </>
        )}
      </Card>

      <div className="grid gap-4 mt-6">
        {(protections.data || []).map((p) => (
          <Card key={p.id} padding={false} noPopIn noHeightAnim>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-3">
              <div>
                <p className="text-primary font-mono text-sm">
                  {driveName(driveList, p.source_drive)}/{p.source_path}
                </p>
                <p className="text-primary text-xs mt-1">
                  Copy on {driveName(driveList, p.target_drive)} · last copy{" "}
                  {p.last_run ? new Date(p.last_run * 1000).toLocaleString() : "never — tap Refresh now to make the first copy"}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" loading={run.isPending} onClick={() => run.mutate(p.id)}>Refresh now</Button>
                <Button size="sm" variant="danger" loading={stop.isPending} onClick={() => stop.mutate(p.id)}>Stop protecting</Button>
              </div>
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
