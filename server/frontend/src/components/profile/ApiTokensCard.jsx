import { useEffect, useState } from "react";
import { KeyRound, Trash2, Plus, Loader2 } from "lucide-react";
import Card from "../cards/Card";
import Button from "../ui/Button";
import CopyableValue from "../ui/CopyableValue";
import { useAuth } from "../../hooks/useAuth";
import { useToast } from "../../context/ToastContext";

function formatDate(iso) {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

// ApiTokensCard lets a user manage their own long-lived API tokens
// (programmatic access). The plaintext token is shown exactly once at creation;
// only the prefix is stored/listed afterwards.
export default function ApiTokensCard() {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState(null); // { token, id, name }
  const [revokingId, setRevokingId] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await request("/api-tokens");
        const data = await res.json();
        if (alive) setTokens(Array.isArray(data?.tokens) ? data.tokens : []);
      } catch {
        if (alive) addToast({ type: "error", message: "We couldn't load your API tokens." });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [request, addToast]);

  async function handleCreate(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    try {
      const res = await request("/api-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json();
      setNewToken({
        token: data.token,
        id: data.api_token?.id,
        name: data.api_token?.name,
      });
      setTokens((prev) => [data.api_token, ...prev]);
      setName("");
      addToast({
        type: "success",
        message: "API token created. Copy it now — you won't be able to see it again.",
      });
    } catch {
      addToast({ type: "error", message: "We couldn't create that API token. Please try again." });
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(token) {
    const ok = window.confirm(
      `Revoke "${token.name}"? Anything using this token will stop working right away.`,
    );
    if (!ok) return;
    setRevokingId(token.id);
    try {
      await request(`/api-tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
      setTokens((prev) => prev.filter((t) => t.id !== token.id));
      if (newToken?.id === token.id) setNewToken(null);
      addToast({ type: "success", message: "API token revoked." });
    } catch {
      addToast({ type: "error", message: "We couldn't revoke that token. Please try again." });
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <Card title="API Tokens" icon={KeyRound} data-slot="api-tokens-card">
      <div className="space-y-4">
        <p className="text-sm text-secondary/70">
          API tokens let other apps and scripts talk to your LibreServ on your
          behalf, without using your password. Keep them as secret as a password.
        </p>

        {newToken && (
          <div className="rounded-large-element border-2 border-accent/40 bg-primary text-secondary p-4 space-y-3">
            <p className="text-sm font-mono">
              Copy this token now — you won&apos;t be able to see it again.
            </p>
            <CopyableValue
              value={newToken.token}
              copyLabel="Copy token"
              ariaLabel="API token"
              surface="primary"
              multiline
            />
            <p className="text-xs text-secondary">
              Use it in your app or script by sending it as an{" "}
              <span className="font-mono">Authorization: Bearer</span> header.
            </p>
            <button
              type="button"
              onClick={() => setNewToken(null)}
              className="text-xs text-accent hover:text-secondary"
            >
              I&apos;ve copied it — dismiss
            </button>
          </div>
        )}

        <form onSubmit={handleCreate} className="flex items-center gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token name (e.g. Backup script)"
            className="flex-1 px-4 py-2 border-2 border-secondary/30 rounded-large-element bg-secondary text-primary focus:ring-2 focus:ring-accent focus:ring-offset-2"
            disabled={creating}
          />
          <Button type="submit" disabled={creating || !name.trim()}>
            {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            Create
          </Button>
        </form>

        {loading ? (
          <p className="text-sm text-accent">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-secondary/70">
            You haven&apos;t created any API tokens yet.
          </p>
        ) : (
          <ul className="divide-y divide-primary/10">
            {tokens.map((t) => (
              <li key={t.id} className="py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-primary truncate">{t.name}</div>
                  <div className="text-xs text-accent font-mono">{t.token_prefix}</div>
                  <div className="text-xs text-secondary/60">
                    Created {formatDate(t.created_at)} · Last used {formatDate(t.last_used_at)}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRevoke(t)}
                  disabled={revokingId === t.id}
                  aria-label={`Revoke token ${t.name}`}
                >
                  {revokingId === t.id ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Trash2 size={16} />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}