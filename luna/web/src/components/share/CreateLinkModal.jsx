import { useState } from "react";
import PropTypes from "prop-types";
import { useMutation } from "@tanstack/react-query";
import ModalCard from "@libreloom/ui/components/cards/ModalCard.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import CopyableValue from "@libreloom/ui/components/ui/CopyableValue.jsx";
import Dropdown from "@libreloom/ui/components/common/Dropdown.jsx";
import PageNotice from "@libreloom/ui/components/common/PageNotice.jsx";
import ShakeTarget from "@libreloom/ui/components/ui/ShakeTarget.jsx";
import { patchJson, postJson, apiErrorMessage } from "../../lib/api";
import { capsHint, capsLabel, capsOptions, rememberLinkUrl } from "../../lib/access.js";
import { isFormFile } from "../../lib/fileKinds.js";
import { haptic } from "@libreloom/ui/utils/haptics.js";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";

const LINK_ERROR = "Couldn't create that link. Check that it's still on this Luna, then try again.";
const LINK_SAVE_ERROR = "Couldn't save those link settings. Try again.";

const KEEP_EXPIRY = "__keep";

const EXPIRY_OPTIONS = [
  { value: "7", label: "Expires in 7 days" },
  { value: "30", label: "Expires in 30 days" },
  { value: "365", label: "Expires in a year" },
  { value: "", label: "Never expires" },
];

/**
 * Mint one `/s/` link for any subject — file, folder, drive, or album —
 * or, when `link` is passed, edit that link's caps, password, and expiry.
 * Options are pre-filtered to levels valid for the subject and covered by
 * the caller's own access, so there is no invalid choice to make.
 *
 * @param {{
 *   subject: { kind: string, drive_id: string, path?: string, album_id?: string, is_file?: boolean },
 *   myCaps: string,
 *   link?: { id: string, caps: string, has_password?: boolean, expires_at?: number|null } | null,
 *   open?: boolean,
 *   onClose: () => void,
 *   onDone: () => void,
 *   onError?: (msg: string) => void,
 *   overlayClassName?: string,
 * }} props
 */
export default function CreateLinkModal({
  subject,
  myCaps,
  link = null,
  open = true,
  onClose,
  onDone,
  onError,
  overlayClassName,
}) {
  const { addToast } = useToast();
  const editing = link != null;
  const isAlbum = subject?.kind === "album";
  const isFile = subject?.is_file === true;
  const isForm = isFile && isFormFile(subject?.path || "");
  const grantable = capsOptions({ kind: subject?.kind, isFile, isForm }, myCaps, { forLink: true });
  const options = editing && link.caps && !grantable.some((o) => o.value === link.caps)
    ? [{ value: link.caps, label: capsLabel(link.caps, { album: isAlbum, file: isFile }) }, ...grantable]
    : grantable;
  // Forms default to "Collect answers" — that's what a form link is for.
  const defaultCaps = isForm && options.some((o) => o.value === "respond")
    ? "respond"
    : options[0]?.value || "";
  const [caps, setCaps] = useState(editing ? link.caps : defaultCaps);
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [days, setDays] = useState(editing ? KEEP_EXPIRY : "30");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(/** @type {string|null} */ (null));

  const mutation = useMutation({
    mutationFn: (/** @type {any} */ body) =>
      editing
        ? patchJson(`/api/v1/access/links/${link.id}`, body)
        : postJson("/api/v1/access/links", body),
    onMutate: () => setError(null),
    onSuccess: (data) => {
      if (editing) {
        addToast({ type: "success", message: "Link updated." });
        setError(null);
        onDone();
        return;
      }
      if (!data?.url) {
        haptic("error");
        setError(LINK_ERROR);
        onError?.(LINK_ERROR);
        return;
      }
      addToast({ type: "success", message: "Link created." });
      setError(null);
      const url = window.location.origin + data.url;
      rememberLinkUrl(data.id, url);
      setResult({ ...data, fullUrl: url });
    },
    onError: (err) => {
      haptic("error");
      const msg = apiErrorMessage(err, editing ? LINK_SAVE_ERROR : LINK_ERROR);
      setError(msg);
      onError?.(msg);
    },
  });

  const picked = options.some((o) => o.value === caps) ? caps : defaultCaps;
  const expiryOptions = editing
    ? [{ value: KEEP_EXPIRY, label: "Keep current expiry" }, ...EXPIRY_OPTIONS]
    : EXPIRY_OPTIONS;

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

  function submit() {
    if (editing) {
      const body = {};
      if (picked !== link.caps) body.caps = picked;
      if (days !== KEEP_EXPIRY) body.expires_in_days = days ? Number(days) : null;
      if (password) body.password = password;
      else if (removePassword) body.password = null;
      mutation.mutate(body);
      return;
    }
    mutation.mutate({
      kind: subject.kind,
      drive_id: subject.drive_id,
      path: subject.path || "",
      album_id: subject.album_id || "",
      caps: picked,
      password: password || undefined,
      expires_in_days: days ? Number(days) : undefined,
    });
  }

  return (
    <ModalCard
      open={open}
      title={editing ? "Link settings" : "New link"}
      onClose={onClose}
      overlayClassName={overlayClassName}
    >
      {({ close }) => (
        <div className="space-y-3">
          {error && <PageNotice variant="error">{error}</PageNotice>}
          <Dropdown
            options={options}
            value={picked}
            onChange={setCaps}
            fullWidth
            bg="primary"
            aria-label="What people with this link can do"
          />
          <p className="text-primary text-xs">
            {capsHint(picked, { album: isAlbum, file: isFile, form: isForm })}
          </p>
          <ShakeTarget shake={error}>
            <input
              type="password"
              className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
              placeholder={editing ? "New password (leave blank to keep)" : "Optional password"}
              aria-label="Link password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </ShakeTarget>
          {editing && link.has_password && (
            <label className="flex items-center gap-2 text-primary text-sm">
              <input
                type="checkbox"
                checked={removePassword}
                disabled={Boolean(password)}
                onChange={(e) => setRemovePassword(e.target.checked)}
              />
              Remove password
            </label>
          )}
          <Dropdown
            options={expiryOptions}
            value={days}
            onChange={setDays}
            fullWidth
            bg="primary"
            aria-label="Link expiry"
          />
          <div className="flex gap-3">
            <Button
              variant="primary"
              fullWidth
              loading={mutation.isPending}
              disabled={!subject?.drive_id || !picked}
              onClick={submit}
            >
              {editing ? "Save changes" : "Create link"}
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

CreateLinkModal.propTypes = {
  subject: PropTypes.shape({
    kind: PropTypes.string,
    drive_id: PropTypes.string,
    path: PropTypes.string,
    album_id: PropTypes.string,
    is_file: PropTypes.bool,
  }),
  myCaps: PropTypes.string,
  link: PropTypes.shape({
    id: PropTypes.string.isRequired,
    caps: PropTypes.string.isRequired,
    has_password: PropTypes.bool,
    expires_at: PropTypes.number,
  }),
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  onDone: PropTypes.func.isRequired,
  onError: PropTypes.func,
  overlayClassName: PropTypes.string,
};
