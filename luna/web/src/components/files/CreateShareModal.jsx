import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import ModalCard from "../cards/ModalCard";
import Button from "../ui/Button";
import Dropdown from "../common/Dropdown";
import { postJson, apiErrorMessage } from "../../lib/api";

export default function CreateShareModal({
  drives,
  onClose,
  onError,
  onDone,
  initialDriveId = "",
  initialPath = "",
}) {
  const [driveId, setDriveId] = useState(initialDriveId);
  const [path, setPath] = useState(initialPath);
  const [password, setPassword] = useState("");
  const [days, setDays] = useState("30");
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const mutation = useMutation({
    mutationFn: (/** @type {any} */ body) => postJson("/api/v1/shares", body),
    onSuccess: (data) => {
      const url = window.location.origin + data.url;
      try {
        sessionStorage.setItem(`luna-share-${data.id}`, url);
      } catch {
        // private mode
      }
      setResult({ ...data, fullUrl: url });
    },
    onError: (err) => onError(apiErrorMessage(err)),
  });

  async function copyLink() {
    if (!result?.fullUrl) return;
    try {
      await navigator.clipboard.writeText(result.fullUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (result) {
    return (
      <ModalCard title="Link ready" onClose={onDone}>
        <p className="text-primary text-sm">
          Send this address. Anyone with it can see the file or folder
          {password ? " after they type the password you set" : ""}.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            readOnly
            className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
            value={result.fullUrl}
            onFocus={(e) => e.target.select()}
          />
          <Button size="sm" variant="primary" onClick={copyLink}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="mt-3 text-sm text-primary">
          Luna shows this address once. If you lose it, make a new link.
        </p>
        <div className="mt-4 flex gap-3">
          <Button variant="outline" onClick={onDone}>Done</Button>
        </div>
      </ModalCard>
    );
  }

  return (
    <ModalCard title="Share something" onClose={onClose}>
      <p className="text-primary text-sm mb-3">
        This makes an address you can send. People do not need a Luna account.
        Type the folder the way it looks when you open files — for example photos/summer.
      </p>
      <div className="space-y-3">
        <Dropdown
          options={(drives || []).map((d) => ({ value: d.id, label: d.label }))}
          value={driveId}
          onChange={setDriveId}
          placeholder="Choose a drive"
          fullWidth
        />
        <input
          className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
          placeholder="Folder (leave empty for the whole drive)"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <input
          type="password"
          className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
          placeholder="Optional password for this link"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Dropdown
          options={[
            { value: "7", label: "Expires in 7 days" },
            { value: "30", label: "Expires in 30 days" },
            { value: "365", label: "Expires in a year" },
            { value: "", label: "Never expires" },
          ]}
          value={days}
          onChange={setDays}
          fullWidth
        />
        <Button
          variant="primary"
          fullWidth
          loading={mutation.isPending}
          disabled={!driveId}
          onClick={() => mutation.mutate({
            drive_id: driveId,
            path: path.trim(),
            password: password || undefined,
            expires_in_days: days ? Number(days) : undefined,
          })}
        >
          Create link
        </Button>
      </div>
    </ModalCard>
  );
}
