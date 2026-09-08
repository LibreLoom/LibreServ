import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import ModalCard from "../cards/ModalCard";
import Button from "../ui/Button";
import CopyableValue from "../ui/CopyableValue";
import Dropdown from "../common/Dropdown";
import PageNotice from "../common/PageNotice";
import ShakeTarget from "../ui/ShakeTarget";
import { postJson, apiErrorMessage } from "../../lib/api";

const LINK_ERROR = "Couldn't create that link. Check that the file or folder is still on this drive, then try again.";

const SHARE_PERMISSION_OPTIONS = [
  { value: "read", label: "Read only" },
  { value: "write", label: "Read and write" },
  { value: "upload", label: "Upload only" },
];

/**
 * @param {{ driveId: any, path?: string, kind?: string, onClose: any, onError?: (msg: string) => void, onDone: any, open?: boolean, overlayClassName?: string }} props
 */
export default function CreateShareModal({
  driveId,
  path = "",
  kind = "folder",
  onClose,
  onError,
  onDone,
  open = true,
  overlayClassName,
}) {
  const [password, setPassword] = useState("");
  const [days, setDays] = useState("30");
  const [permission, setPermission] = useState("read");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(/** @type {string|null} */ (null));
  const mutation = useMutation({
    mutationFn: (/** @type {any} */ body) => postJson("/api/v1/shares", body),
    onMutate: () => setError(null),
    onSuccess: (data) => {
      if (!data?.url) {
        const msg = LINK_ERROR;
        setError(msg);
        onError?.(msg);
        return;
      }
      setError(null);
      const url = window.location.origin + data.url;
      try {
        sessionStorage.setItem(`luna-share-${data.id}`, url);
      } catch {
        // private mode
      }
      setResult({ ...data, fullUrl: url });
    },
    onError: (err) => {
      const msg = apiErrorMessage(err, LINK_ERROR);
      setError(msg);
      onError?.(msg);
    },
  });

  const uploadOnlyOnFile = kind === "file" && permission === "upload";

  if (result) {
    return (
      <ModalCard open={open} title="Link ready" onClose={onDone} overlayClassName={overlayClassName}>
        {({ close }) => (
          <>
            <CopyableValue
              value={result.fullUrl}
              copyLabel="Copy"
              ariaLabel="Share link"
            />
            <div className="mt-4 flex gap-3">
              <Button variant="outline" onClick={close}>Done</Button>
            </div>
          </>
        )}
      </ModalCard>
    );
  }

  return (
    <ModalCard open={open} title="New link" onClose={onClose} overlayClassName={overlayClassName}>
      {({ close }) => (
        <div className="space-y-3">
          {error && <PageNotice variant="error">{error}</PageNotice>}
          {uploadOnlyOnFile && (
            <PageNotice variant="warning">
              Upload-only links need a folder. Pick Read only or Read and write, or share a folder instead.
            </PageNotice>
          )}
          <Dropdown
            options={SHARE_PERMISSION_OPTIONS}
            value={permission}
            onChange={setPermission}
            fullWidth
            bg="primary"
            aria-label="What people with this link can do"
          />
          <p className="text-primary text-xs">
            <span className="text-primary font-semibold">Read only</span>{" "}
            opens and downloads files.{" "}
            <span className="text-primary font-semibold">Read and write</span>{" "}
            can also add files, but can't delete or rename anything.{" "}
            <span className="text-primary font-semibold">Upload only</span>{" "}
            can add files but can't see what's already there — great for collecting photos from people.
          </p>
          <ShakeTarget shake={error}>
            <input
              type="password"
              className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
              placeholder="Optional password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </ShakeTarget>
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
            bg="primary"
          />
          <div className="flex gap-3">
            <Button
              variant="primary"
              fullWidth
              loading={mutation.isPending}
              disabled={!driveId || uploadOnlyOnFile}
              onClick={() => mutation.mutate({
                drive_id: driveId,
                path: (path || "").trim(),
                password: password || undefined,
                expires_in_days: days ? Number(days) : undefined,
                permission,
              })}
            >
              Create link
            </Button>
            <Button variant="outline" onClick={close} disabled={mutation.isPending}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </ModalCard>
  );
}
