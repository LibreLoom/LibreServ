import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Download, File as FileIcon, Folder, Lock } from "lucide-react";
import Card from "../components/cards/Card";
import Button from "../components/ui/Button";
import ShakeTarget from "../components/ui/ShakeTarget";
import EmptyState from "../components/common/EmptyState";
import PageNotice from "../components/common/PageNotice";

function joinRel(base, name) {
  return base ? `${base}/${name}` : name;
}

function parentRel(path) {
  if (!path) return "";
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

export default function PublicSharePage() {
  const { token } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const rel = searchParams.get("path") || "";
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState(false);
  const [submittedPassword, setSubmittedPassword] = useState("");
  const [error, setError] = useState("");
  const [listing, setListing] = useState(null);
  const [fileOnly, setFileOnly] = useState(false);
  const [loading, setLoading] = useState(true);

  const downloadHref = (childRel, asDownload) => {
    const params = new URLSearchParams();
    if (childRel) params.set("path", childRel);
    if (asDownload) params.set("download", "1");
    const q = params.toString();
    return `/s/${token}${q ? `?${q}` : ""}`;
  };

  useEffect(() => {
    let alive = true;
    async function load() {
      setLoading(true);
      setError("");
      setFileOnly(false);
      try {
        const params = new URLSearchParams();
        if (rel) params.set("path", rel);
        const q = params.toString();
        const headers = { Accept: "application/json" };
        if (submittedPassword) headers["X-Share-Password"] = submittedPassword;
        const res = await fetch(`/s/${token}${q ? `?${q}` : ""}`, { headers });
        const type = res.headers.get("content-type") || "";
        if (res.status === 401) {
          if (alive) {
            setNeedPassword(true);
            setListing(null);
            setError(submittedPassword ? "That password is wrong. Try again." : "This link needs its password.");
          }
          return;
        }
        if (res.status === 410) {
          if (alive) {
            setListing(null);
            setError("This link has expired. Ask the person who sent it to make a new one.");
          }
          return;
        }
        if (res.status === 404) {
          if (alive) {
            setListing(null);
            setError("This link doesn't exist, or the files aren't on Luna right now.");
          }
          return;
        }
        if (!res.ok) {
          const data = type.includes("json") ? await res.json().catch(() => ({})) : {};
          if (alive) setError(data.error || "Luna couldn't open this link.");
          return;
        }
        if (type.includes("json")) {
          const data = await res.json();
          if (alive) {
            setNeedPassword(false);
            setListing(data);
          }
        } else if (alive) {
          setNeedPassword(false);
          setFileOnly(true);
          setListing(null);
        }
      } catch {
        if (alive) setError("Couldn't reach Luna. If you're away from home, turn on Luna Connect in Settings → External Services. Otherwise check you're on the same Wi‑Fi as Luna.");
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    return () => { alive = false; };
  }, [token, rel, submittedPassword]);

  function openRel(next) {
    const nextParams = new URLSearchParams(searchParams);
    if (next) nextParams.set("path", next);
    else nextParams.delete("path");
    setSearchParams(nextParams);
  }

  return (
    <div className="min-h-screen bg-primary text-secondary px-4 py-12 flex flex-col items-center">
      <div className="w-full max-w-lg">
        <h1 className="font-mono text-2xl text-center mb-6">Shared with you</h1>
        {error && <PageNotice variant="error" className="mb-4">{error}</PageNotice>}

        {needPassword && (
          <Card icon={Lock} title="This link is locked">
            <p className="text-primary text-sm">
              The person who sent this chose a password. Type it to see the files.
            </p>
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setSubmittedPassword(password);
              }}
            >
              <ShakeTarget shake={error}>
                <input
                  type="password"
                  className="w-full rounded-pill bg-primary text-secondary border-2 border-secondary/30 px-4 py-2 text-sm"
                  placeholder="Password for this link"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                />
              </ShakeTarget>
              <Button type="submit" variant="primary" fullWidth>Open</Button>
            </form>
          </Card>
        )}

        {loading && !needPassword && (
          <Card>
            <p className="text-primary text-sm">Opening the shared files…</p>
          </Card>
        )}

        {fileOnly && (
          <Card icon={FileIcon} title="A file was shared with you">
            <p className="text-primary text-sm">Tap download to save it on this device.</p>
            <div className="mt-4">
              <Button variant="primary" asChild>
                <a href={downloadHref(rel, true)}>
                  <Download size={16} /> Download
                </a>
              </Button>
            </div>
          </Card>
        )}

        {listing && (
          <div className="space-y-3">
            {rel && (
              <Button variant="outline" surface="primary" size="sm" onClick={() => openRel(parentRel(rel))}>
                ↑ Up one folder
              </Button>
            )}
            {(listing.entries || []).map((entry) => (
              <Card key={entry.name} padding={false} noPopIn noHeightAnim>
                <div className="flex items-center justify-between p-4 gap-2">
                  {entry.kind === "dir" ? (
                    <button
                      type="button"
                      className="flex items-center gap-3 text-left flex-1 min-w-0 text-primary"
                      onClick={() => openRel(joinRel(rel, entry.name))}
                    >
                      <Folder size={18} className="text-accent shrink-0" />
                      <span className="font-mono text-sm truncate">{entry.name}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <FileIcon size={18} className="text-accent shrink-0" />
                      <span className="text-primary font-mono text-sm truncate">{entry.name}</span>
                    </div>
                  )}
                  {entry.kind !== "dir" && (
                    <Button size="sm" variant="outline" asChild>
                      <a href={downloadHref(joinRel(rel, entry.name), true)}>Download</a>
                    </Button>
                  )}
                </div>
              </Card>
            ))}
            {!loading && (listing.entries || []).length === 0 && (
              <EmptyState
                icon={Folder}
                title="This folder is empty"
                description="There's nothing here to download."
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
