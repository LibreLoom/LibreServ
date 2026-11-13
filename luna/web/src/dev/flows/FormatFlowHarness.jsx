// Dev only (routed in App.jsx behind import.meta.env.DEV): opens the real
// FormatDriveFlow for any drive, the way a caller would.
//
// The flow is never a user action of its own: it only opens inside other
// flows (Add drive, and later the encryption hand-offs). So the state gallery
// can't reach every state by clicking — a readable stick with files, a drive
// Luna already has, a password-protected erase — and opens them here instead.
//
//   /__flow/format                       pick a drive
//   /__flow/format?device=sdb            open the flow for that disk
//   /__flow/format?device=sdb&password=x as the encryption sheet would
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Page from "@libreloom/ui/components/ui/Page.jsx";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import InlinePill from "@libreloom/ui/components/common/InlinePill.jsx";
import FormatDriveFlow from "../../components/drives/FormatDriveFlow.jsx";
import { getJson } from "../../lib/api.js";

export default function FormatFlowHarness() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const device = params.get("device");
  const password = params.get("password") || undefined;
  const [open, setOpen] = useState(Boolean(device));
  const [last, setLast] = useState("");

  const detected = useQuery({ queryKey: ["drives-detected"], queryFn: () => getJson("/api/v1/drives/detected") });
  const drives = useQuery({ queryKey: ["drives"], queryFn: () => getJson("/api/v1/drives") });
  const choices = [
    ...(detected.data || []).map((d) => ({ name: d.name, model: d.model, label: d.model || "", format_id: d.format_id, note: "not added" })),
    ...(drives.data || []).filter((d) => d.device).map((d) => ({ name: d.device, label: d.label, format_id: d.format_id, note: `added as ${d.label}` })),
  ];
  const chosen = choices.find((c) => c.name === device) || (device ? { name: device } : null);

  const pick = (name) => {
    const next = new URLSearchParams(params);
    next.set("device", name);
    setParams(next);
    setOpen(true);
  };

  return (
    <Page title="Erase flow (dev)">
      <Card title="Open the erase flow">
        <p className="text-sm">
          Only for the state gallery. In the app this window opens only from inside another flow.
          {password ? <> Opening with a password, as the encryption sheet would.</> : null}
        </p>
        <ul className="mt-3 space-y-2">
          {choices.map((c) => (
            <li key={c.name} className="flex flex-wrap items-center gap-2 text-sm">
              <InlinePill>{c.name}</InlinePill> {c.model || c.label} ({c.note})
              <Button size="sm" variant="outline" onClick={() => pick(c.name)}>Open</Button>
            </li>
          ))}
        </ul>
        {chosen && !open ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            {last ? <span>{last}</span> : null}
            <Button size="sm" onClick={() => setOpen(true)}>Open again</Button>
          </div>
        ) : null}
      </Card>
      {chosen && open ? (
        <FormatDriveFlow
          key={`${chosen.name}:${password ? "p" : ""}`}
          device={chosen}
          password={password}
          onCancel={() => { setOpen(false); setLast("Closed."); }}
          onDone={(driveId) => navigate(`/files/${driveId}`)}
        />
      ) : null}
    </Page>
  );
}
