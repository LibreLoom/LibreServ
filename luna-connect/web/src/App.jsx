import { useEffect, useState } from "react";
import { api } from "./api.js";

function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-pill px-5 py-2 font-mono text-sm transition-colors ${
        active ? "bg-secondary text-primary" : "bg-primary text-secondary border border-secondary"
      }`}
    >
      {children}
    </button>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState("luna");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [mode, setMode] = useState("signin");
  const [devices, setDevices] = useState([]);
  const [objects, setObjects] = useState([]);
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");

  async function refresh() {
    try {
      const m = await api("/api/v1/account/me");
      setMe(m);
      const d = await api("/api/v1/account/devices");
      setDevices(d.devices || []);
      if (m.has_card) {
        const b = await api("/api/v1/backups");
        setObjects(b.objects || []);
        setNote(b.note || "");
      }
    } catch {
      setMe(null);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function submitAuth(e) {
    e.preventDefault();
    setError("");
    try {
      const path = mode === "register" ? "/api/v1/account/register" : "/api/v1/account/login";
      await api(path, { method: "POST", body: JSON.stringify({ email, password }) });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!me) {
    return (
      <div className="bg-primary text-secondary min-h-screen p-8 max-w-lg mx-auto">
        <h1 className="font-mono text-3xl mb-2">Luna Connect</h1>
        <p className="mb-6">Sign in to pair your Luna and keep a spare copy of files off-site.</p>
        <form onSubmit={submitAuth} className="bg-secondary text-primary rounded-large-element p-6 space-y-4">
          <label className="block text-sm">
            Email
            <input className="mt-1 w-full rounded-pill bg-primary text-secondary px-4 py-2" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block text-sm">
            Password
            <input type="password" className="mt-1 w-full rounded-pill bg-primary text-secondary px-4 py-2" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <p className="text-error text-sm">{error}</p>}
          <button type="submit" className="rounded-pill bg-primary text-secondary px-5 py-2 font-mono">
            {mode === "register" ? "Create account" : "Sign in"}
          </button>
          <button type="button" className="block text-sm underline" onClick={() => setMode(mode === "register" ? "signin" : "register")}>
            {mode === "register" ? "I already have an account" : "Create an account"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="bg-primary text-secondary min-h-screen p-8 max-w-3xl mx-auto">
      <h1 className="font-mono text-3xl mb-4">Luna Connect</h1>
      <div className="flex gap-3 mb-8">
        <TabButton active={tab === "luna"} onClick={() => setTab("luna")}>Your Luna</TabButton>
        <TabButton active={tab === "backups"} onClick={() => setTab("backups")}>Cloud backups</TabButton>
      </div>

      {tab === "luna" && (
        <div className="bg-secondary text-primary rounded-large-element p-6 space-y-4">
          <p>Signed in as {me.email}.</p>
          {devices.length === 0 ? (
            <p>No Luna is paired yet. On Luna, turn on remote access, then enter the pairing code here.</p>
          ) : (
            <ul className="space-y-2">
              {devices.map((d) => (
                <li key={d.id} className="font-mono">{d.hostname}</li>
              ))}
            </ul>
          )}
          <form
            className="flex gap-2 flex-wrap"
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              try {
                await api("/api/v1/account/pair", { method: "POST", body: JSON.stringify({ code }) });
                setCode("");
                await refresh();
              } catch (err) {
                setError(err.message);
              }
            }}
          >
            <input className="rounded-pill bg-primary text-secondary px-4 py-2 font-mono" placeholder="Pairing code from Luna" value={code} onChange={(e) => setCode(e.target.value)} />
            <button type="submit" className="rounded-pill bg-primary text-secondary px-5 py-2 font-mono">Pair this Luna</button>
          </form>
          {error && <p className="text-sm">{error}</p>}
        </div>
      )}

      {tab === "backups" && (
        <BackupsTab me={me} objects={objects} note={note} onRefresh={refresh} setError={setError} error={error} />
      )}
    </div>
  );
}

export function BackupsTab({ me, objects, note, onRefresh, setError, error }) {
  if (!me.has_card) {
    return (
      <div className="bg-secondary text-primary rounded-large-element p-6 space-y-4" data-testid="backups-gated">
        <p>Add a payment card so we can store a spare copy of your files off-site. It costs $7 per terabyte each month.</p>
        <button
          type="button"
          className="rounded-pill bg-primary text-secondary px-5 py-2 font-mono"
          onClick={async () => {
            try {
              await api("/api/v1/billing/attach-card", { method: "POST", body: "{}" });
              await onRefresh();
            } catch (err) {
              setError(err.message);
            }
          }}
        >
          Add a payment card
        </button>
        {error && <p>{error}</p>}
      </div>
    );
  }
  return (
    <div className="bg-secondary text-primary rounded-large-element p-6 space-y-4" data-testid="backups-open">
      <p>Spare copies cost $7 per terabyte each month, based on how much is stored right now.</p>
      <p className="font-mono">About ${Number(me.estimated_month || 0).toFixed(2)} this month</p>
      <p>{note || "This is the latest copy we have, not a history of old versions."}</p>
      {objects.length === 0 ? (
        <p>Nothing stored yet. On Luna, choose folders or a whole drive after pairing.</p>
      ) : (
        <ul className="space-y-2">
          {objects.map((o) => (
            <li key={`${o.device_id}-${o.relative_path}`} className="flex justify-between gap-3">
              <span className="font-mono break-all">{o.relative_path}</span>
              <a className="underline" href={`/api/v1/backups/download?device_id=${encodeURIComponent(o.device_id)}&path=${encodeURIComponent(o.relative_path)}`}>Download</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
