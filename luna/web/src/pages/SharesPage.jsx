import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Trash2 } from "lucide-react";
import Page from "../components/ui/Page";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";
import CreateShareModal from "../components/files/CreateShareModal";
import { getDrives, getJson, deleteJson, apiErrorMessage } from "../lib/api";

function expiryLabel(expiresAt) {
  if (!expiresAt) return "never expires";
  const when = new Date(expiresAt * 1000);
  if (Number.isNaN(when.getTime())) return "expires";
  return `expires ${when.toLocaleDateString()}`;
}

export default function SharesPage() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const shares = useQuery({ queryKey: ["shares"], queryFn: () => getJson("/api/v1/shares") });
  const drives = useQuery({ queryKey: ["drives"], queryFn: getDrives });

  const revoke = useMutation({
    mutationFn: (id) => deleteJson(`/api/v1/shares/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["shares"] }),
    onError: (err) => setError(apiErrorMessage(err, "Couldn't remove that link.")),
  });

  return (
    <Page
      title="Links"
      titleId="shares-title"
      bottomContent={<p className="text-sm">Send a link so someone can download files without a Luna account. You can add a password and an expiry date.</p>}
      rightContent={<Button size="sm" variant="primary" onClick={() => { setError(null); setCreating(true); }}><Link2 size={14} /> Share something</Button>}
    >
      {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}
      <div className="grid gap-4">
        {(shares.data || []).map((s) => {
          const remembered = (() => {
            try { return sessionStorage.getItem(`luna-share-${s.id}`); } catch { return null; }
          })();
          const driveName = s.drive_label || (drives.data || []).find((d) => d.id === s.drive_id)?.label || "Drive";
          return (
            <Card key={s.id} padding={false} noPopIn noHeightAnim>
              <div className="flex items-center justify-between p-4 gap-3">
                <div className="min-w-0">
                  <p className="text-primary font-mono text-sm truncate">
                    {driveName}{s.path ? ` / ${s.path}` : " (whole drive)"}
                  </p>
                  <p className="text-primary text-xs mt-1">
                    {s.has_password ? "Password protected" : "Anyone with the link"} · {expiryLabel(s.expires_at)}
                  </p>
                  {remembered ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      onClick={() => navigator.clipboard.writeText(remembered)}
                    >
                      Copy address
                    </Button>
                  ) : (
                    <p className="text-primary text-xs mt-2">
                      Luna showed this address once when you made it. If you lost it, make a new link.
                    </p>
                  )}
                </div>
                <Button size="iconSm" variant="danger" onClick={() => revoke.mutate(s.id)} aria-label="Remove this link">
                  <Trash2 size={12} />
                </Button>
              </div>
            </Card>
          );
        })}
        {(shares.data || []).length === 0 && (
          <EmptyState
            icon={Link2}
            title="No links yet"
            description="Share a file or folder from Files, or tap Share something. The other person opens the address in a browser — they do not need a Luna account."
          />
        )}
      </div>

      {creating && (
        <CreateShareModal
          drives={drives.data || []}
          onClose={() => setCreating(false)}
          onError={setError}
          onDone={() => { setCreating(false); queryClient.invalidateQueries({ queryKey: ["shares"] }); }}
        />
      )}
    </Page>
  );
}
