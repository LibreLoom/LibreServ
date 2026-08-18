import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, PlugZap, TriangleAlert } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import ModalCard from "../components/cards/ModalCard";
import Pill from "../components/common/Pill";
import Button from "../components/ui/Button";
import TextLink from "../components/ui/TextLink";
import { useAuth } from "../context/AuthContext";
import { getDrives, getJson, postJson } from "../lib/api";

const STATE_PILLS = {
  as_is: "success",
  readonly: "warning",
  missing: "warning",
  ejected: "info",
  failed: "error",
};

function sizeLabel(bytes) {
  if (!bytes) return "";
  const gb = bytes / 1000 / 1000 / 1000;
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`;
  return `${gb.toFixed(0)} GB`;
}

function DetectedCard({ drive, onOpen }) {
  return (
    <Card icon={HardDrive} title={drive.model || `Drive ${drive.name}`} headerActions={
      <Button size="sm" variant="outline" onClick={() => onOpen(drive)}>
        Look inside
      </Button>
    }>
      <p className="text-primary text-sm">
        {sizeLabel(drive.size_bytes) || "A new drive"} · found on {drive.name}
      </p>
      <p className="text-accent text-xs mt-2">
        Luna hasn&apos;t changed anything on this drive.
      </p>
    </Card>
  );
}

function AdoptedCard({ drive }) {
  const state = STATE_PILLS[drive.state] || "info";
  return (
    <Card icon={HardDrive} title={drive.label} headerActions={<Pill variant={state}>{drive.state}</Pill>}>
      <p className="text-primary text-sm">
        Connected as {drive.device} · {drive.fs_type || "drive"}
      </p>
      <div className="mt-3">
        <Button size="sm" variant="outline" asChild>
          <a href={`/drives/${drive.id}`}>Open files</a>
        </Button>
      </div>
    </Card>
  );
}

export default function DrivesPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });
  const detected = useQuery({
    queryKey: ["drives-detected"],
    queryFn: () => getJson("/api/v1/drives/detected"),
    refetchInterval: 5000,
    enabled: isAdmin,
  });
  const [inspectFor, setInspectFor] = useState(null);

  const inspect = useMutation({
    mutationFn: (/** @type {any} */ drive) => postJson(`/api/v1/drives/${drive.name}/inspect`, {}),
  });

  const adopt = useMutation({
    mutationFn: (/** @type {{ drive: any, label: string }} */ { drive, label }) => postJson(`/api/v1/drives/${drive.name}/adopt`, { label }),
    onSuccess: () => {
      setInspectFor(null);
      queryClient.invalidateQueries({ queryKey: ["drives"] });
      queryClient.invalidateQueries({ queryKey: ["drives-detected"] });
    },
  });

  const adoptError = adopt.isError ? String(adopt.error) : null;

  return (
    <Page title="Drives" titleId="drives-title" bottomContent={<TextLink to="/">← Back home</TextLink>}>
      {(drives.data || []).length === 0 && (
        <Card icon={PlugZap} title="No drives yet" className="mb-6">
          <p className="text-primary text-sm">
            Plug a USB drive into one of Luna&apos;s USB ports. Luna will
            notice it in a few seconds — and won&apos;t touch anything.
          </p>
        </Card>
      )}

      {(drives.data || []).length > 0 && (
        <div className="grid gap-5 md:grid-cols-2 mb-6">
          {drives.data.map((drive) => <AdoptedCard key={drive.id} drive={drive} />)}
        </div>
      )}

      {isAdmin && (
        <>
          <h2 className="font-mono text-sm text-secondary mb-4 mt-10">Drives plugged in now</h2>
          <div className="grid gap-5 md:grid-cols-2">
            {(detected.data || []).map((drive) => <DetectedCard key={drive.name} drive={drive} onOpen={setInspectFor} />)}
          </div>
          {!detected.isLoading && (detected.data || []).length === 0 && (
            <p className="text-secondary text-sm">Nothing new plugged in.</p>
          )}
        </>
      )}

      {inspectFor && (
        <InspectModal
          drive={inspectFor}
          result={inspect.data}
          loading={inspect.isPending}
          error={inspect.isError ? "Luna couldn't look at this drive safely. Make sure it's plugged in and try again." : null}
          onClose={() => { setInspectFor(null); inspect.reset(); }}
          onInspect={() => inspect.mutate(inspectFor)}
          onAdopt={(label) => adopt.mutate({ drive: inspectFor, label })}
          adoptError={adoptError}
          adopting={adopt.isPending}
        />
      )}
    </Page>
  );
}

function InspectModal({ drive, result, loading, error, onClose, onInspect, onAdopt, adoptError, adopting }) {
  const [label, setLabel] = useState(drive.model || "My Drive");
  const needsInspect = !result && !loading && !error;
  const readyToAdopt = result && !result.has_marker;

  return (
    <ModalCard onClose={onClose} title={`Look inside ${drive.model || drive.name}`}>
      {needsInspect && (
        <>
          <p className="text-primary text-sm">
            Luna will look at this drive in read-only mode. Nothing will be
            written, moved, or changed.
          </p>
          <div className="mt-4 flex gap-3">
            <Button variant="secondary" onClick={onInspect}>Look inside</Button>
            <Button variant="outline" onClick={onClose}>Not now</Button>
          </div>
        </>
      )}

      {loading && <p className="text-primary text-sm">Looking…</p>}

      {error && (
        <>
          <p className="text-primary text-sm">{error}</p>
          <div className="mt-4"><Button variant="outline" onClick={onClose}>Close</Button></div>
        </>
      )}

      {result && (
        <>
          <p className="text-primary text-sm">
            We found {result.folders} folders and {result.files} files on this
            drive{result.unreadable > 0 ? ` (${result.unreadable} could not be read)` : ""}.
          </p>
          {result.has_marker && (
            <p className="text-accent text-sm mt-2">This drive already belongs to a Luna.</p>
          )}
          {readyToAdopt && (
            <>
              <div className="mt-4 flex items-center gap-3">
                <TriangleAlert size={18} className="text-warning shrink-0" />
                <p className="text-primary text-xs">
                  Adding it only writes one tiny <span className="font-mono">.luna</span> marker
                  file at the top of the drive. Your files are untouched.
                </p>
              </div>
              <label className="block mt-4">
                <span className="text-primary text-xs">What should Luna call this drive?</span>
                <input
                  className="mt-2 w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                  value={label}
                  maxLength={80}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              {adoptError && <p className="text-error text-xs mt-2">{adoptError}</p>}
              <div className="mt-4 flex gap-3">
                <Button variant="secondary" loading={adopting} onClick={() => onAdopt(label)}>
                  Add this drive
                </Button>
                <Button variant="outline" onClick={onClose}>Not now</Button>
              </div>
            </>
          )}
        </>
      )}
    </ModalCard>
  );
}
