import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import SegmentedControl from "@libreloom/ui/components/common/SegmentedControl.jsx";
import { useToast } from "@libreloom/ui/context/ToastContext.jsx";
import { useShortcut } from "@libreloom/ui/context/ShortcutsContext.jsx";
import { scenarios } from "../scenarios/registry.js";
import { scenarioFrameUrl } from "./frameUrl.js";
import { loadResults, saveResult } from "./results.js";

const VIEWPORTS = {
  phone: { w: 390, h: 800, label: "Phone" },
  tablet: { w: 820, h: 1000, label: "Tablet" },
  desktop: { w: 0, h: 0, label: "Desktop" },
};
const FAULT_MODES = ["500", "403", "404", "409", "401", "offline", "hang", "slow:4000", "empty", "badjson"];
const LATENCIES = [["0", "No delay"], ["600", "0.6 s"], ["2500", "2.5 s"], ["8000", "8 s"]];
const DOT = { pass: "bg-success", fail: "bg-error", skip: "bg-warning", retest: "bg-warning" };

const hashId = () => decodeURIComponent(window.location.hash.slice(1));

export default function Gallery() {
  const { addToast } = useToast();
  const [results, setResults] = useState({});
  const [selectedId, setSelectedId] = useState(() => hashId() || scenarios[0]?.id);
  const [filter, setFilter] = useState("");
  const [only, setOnly] = useState("all");
  const [viewport, setViewport] = useState("desktop");
  const [theme, setTheme] = useState("");
  const [frameKey, setFrameKey] = useState(0);
  const [snap, setSnap] = useState(null);
  const [framePath, setFramePath] = useState("");
  const [advance, setAdvance] = useState(() => {
    try { return localStorage.getItem("luna.statesAdvance") !== "off"; } catch { return true; }
  });
  const [editingPath, setEditingPath] = useState(false);
  const frameRef = useRef(null);
  const unsubRef = useRef(null);
  const timerRef = useRef(0);
  // Notes being typed live in the result box; the gallery only keeps a copy for the P key.
  const draftsRef = useRef({});

  const scenario = scenarios.find((s) => s.id === selectedId) || scenarios[0];

  useEffect(() => { loadResults().then(setResults); }, []);
  const selectedRef = useRef(selectedId);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => { window.location.hash = encodeURIComponent(selectedId || ""); }, [selectedId]);
  // Follow the address bar too, so a pasted or edited link opens that scenario.
  useEffect(() => {
    const onHash = () => {
      const id = hashId();
      // Our own hash update lands here too; only a pasted or edited link should reload.
      if (id && id !== selectedRef.current && scenarios.some((s) => s.id === id)) { setSelectedId(id); setFrameKey((k) => k + 1); setSnap(null); }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const control = useCallback(() => frameRef.current?.contentWindow?.__lunaFake, []);

  // Show where the app is now, since the frame has no address bar of its own.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (editingPath) return;
      const l = frameRef.current?.contentWindow?.location;
      if (l) setFramePath(`${l.pathname}${l.search}${l.hash}`);
    }, 400);
    return () => window.clearInterval(id);
  }, [editingPath]);

  // Move inside the running app without a reload, so the fake data stays.
  const goToPath = (e) => {
    e.preventDefault();
    const w = frameRef.current?.contentWindow;
    if (!w) return;
    const next = framePath.startsWith("/") ? framePath : `/${framePath}`;
    w.history.pushState({}, "", next);
    w.dispatchEvent(new PopStateEvent("popstate"));
    setEditingPath(false);
  };

  // The frame's load event fires before the async mock boot has installed the
  // fake, so wait for it to appear.
  const onFrameLoad = useCallback(() => {
    unsubRef.current?.();
    let tries = 0;
    const attach = () => {
      const c = control();
      if (c) {
        setSnap(c.snapshot());
        unsubRef.current = c.subscribe(() => setSnap(c.snapshot()));
      } else if (tries++ < 40) {
        timerRef.current = window.setTimeout(attach, 100);
      }
    };
    attach();
  }, [control]);
  useEffect(() => () => { unsubRef.current?.(); clearTimeout(timerRef.current); }, []);

  const visible = useMemo(() => scenarios.filter((s) => {
    const r = results[s.id]?.status || "untested";
    if (only !== "all" && r !== only) return false;
    const q = filter.trim().toLowerCase();
    return !q || `${s.area} ${s.title} ${s.id}`.toLowerCase().includes(q);
  }), [filter, only, results]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const s of visible) map.set(s.area, [...(map.get(s.area) || []), s]);
    return [...map.entries()];
  }, [visible]);

  const counts = useMemo(() => {
    const c = { pass: 0, fail: 0, skip: 0, retest: 0 };
    for (const s of scenarios) { const st = results[s.id]?.status; if (st) c[st] += 1; }
    return { ...c, untested: scenarios.length - c.pass - c.fail - c.skip - c.retest };
  }, [results]);

  const pick = useCallback((id) => { setSelectedId(id); setFrameKey((k) => k + 1); setSnap(null); }, []);
  const step = (dir) => {
    const i = visible.findIndex((s) => s.id === scenario?.id);
    const next = visible[Math.min(visible.length - 1, Math.max(0, i + dir))];
    if (next) pick(next.id);
  };

  const record = async (status, note) => {
    const c = control();
    const s = c?.snapshot();
    const result = {
      status,
      note,
      at: new Date().toISOString(),
      viewport,
      theme: theme || "scenario default",
      ...(status === "fail" && s ? { faults: s.faults, offline: s.offline, latency: s.latency, lastRequests: s.log.slice(0, 15) } : {}),
    };
    try {
      await saveResult(scenario.id, result);
      setResults((r) => ({ ...r, [scenario.id]: result }));
      const moving = advance;
      addToast({ type: "success", message: `${status === "fail" ? "Marked as a problem." : "Saved."}${moving ? " Next scenario." : ""}` });
      if (moving) step(1);
    } catch {
      addToast({ type: "error", message: "Couldn't save the result.", description: "Is the dev server still running?" });
    }
  };

  useShortcut("j", () => step(1), { label: "Next scenario", group: "Testing" });
  useShortcut("k", () => step(-1), { label: "Previous scenario", group: "Testing" });
  useShortcut("p", () => record("pass", draftsRef.current[scenario.id] ?? results[scenario.id]?.note ?? ""), { label: "Mark as passed", group: "Testing" });
  useShortcut("f", () => document.getElementById("note-input")?.focus(), { label: "Write down a problem", group: "Testing" });
  useShortcut("r", () => setFrameKey((k) => k + 1), { label: "Reload scenario", group: "Testing" });

  if (!scenario) return <p className="p-8 surface-primary">No scenarios yet.</p>;

  const vp = VIEWPORTS[viewport];
  const frameSrc = scenarioFrameUrl(scenario.url, scenario.id);
  const status = results[scenario.id]?.status || "untested";

  return (
    <div className="flex h-screen surface-primary">
      {/* Scenario list */}
      <aside className="flex w-72 shrink-0 flex-col gap-3 border-r border-accent p-4">
        <h1 className="font-mono text-lg">State gallery</h1>
        <p className="text-xs">
          {counts.pass} passed · {counts.fail} problems · {counts.retest} to retest · {counts.untested} not tested
        </p>
        <input
          className="rounded-pill border border-accent bg-transparent px-4 py-2 text-sm focus:border-accent"
          placeholder="Search scenarios"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <SegmentedControl
          surface="primary"
          aria-label="Show"
          value={only}
          onChange={setOnly}
          options={[{ value: "all", label: "All" }, { value: "untested", label: "New" }, { value: "fail", label: "Fails" }, { value: "retest", label: "Retest" }]}
        />
        <ScenarioList grouped={grouped} selectedId={scenario.id} results={results} onPick={pick} />
      </aside>

      {/* The app, in a real frame so a reload is a true fresh start */}
      <main className="flex min-w-0 grow flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            surface="primary"
            aria-label="Screen size"
            value={viewport}
            onChange={setViewport}
            options={Object.entries(VIEWPORTS).map(([value, v]) => ({ value, label: v.label }))}
          />
          <SegmentedControl
            surface="primary"
            aria-label="Theme"
            value={theme || "default"}
            onChange={(v) => {
              const next = v === "default" ? "" : v;
              setTheme(next);
              try { if (next) localStorage.setItem("theme", next); } catch { /* storage blocked */ }
              setFrameKey((k) => k + 1);
            }}
            options={[{ value: "default", label: "Scenario" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
          />
          <Button variant="outline" surface="primary" size="sm" onClick={() => setFrameKey((k) => k + 1)}>Reload (fresh data)</Button>
          <a className="text-sm underline" href={frameSrc} target="_blank" rel="noreferrer">Open on its own</a>
        </div>
        <form onSubmit={goToPath} className="flex items-center gap-2">
          <input
            aria-label="Address inside the app"
            className="min-w-0 grow rounded-pill border border-accent bg-transparent px-4 py-1.5 text-sm focus:border-accent"
            placeholder="/files"
            value={framePath}
            onFocus={() => setEditingPath(true)}
            onBlur={() => setEditingPath(false)}
            onChange={(e) => setFramePath(e.target.value)}
          />
          <Button type="submit" variant="outline" surface="primary" size="sm">Go</Button>
        </form>
        <div className="flex min-h-0 grow justify-center overflow-auto rounded-large-element border border-accent p-2">
          <iframe
            key={`${scenario.id}:${frameKey}`}
            ref={frameRef}
            title={scenario.title}
            src={frameSrc}
            onLoad={onFrameLoad}
            className="rounded-large-element border-0 surface-primary"
            style={vp.w ? { width: vp.w, height: vp.h } : { width: "100%", height: "100%" }}
          />
        </div>
      </main>

      {/* Checklist, result and fault controls */}
      <aside className="flex w-96 shrink-0 flex-col gap-4 overflow-y-auto border-l border-accent p-4">
        <section className="rounded-large-element p-4 surface-secondary">
          <p className="text-xs">{scenario.area} · {status === "untested" ? "Not tested" : status}</p>
          <h2 className="mb-2 font-mono text-base">{scenario.title}</h2>
          {scenario.realLunadOnly && (
            <p className="mb-2 rounded-large-element border border-warning/30 bg-warning/20 p-2 text-xs">
              Needs real Luna: {scenario.realLunadOnly}
            </p>
          )}
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {scenario.check.length ? scenario.check.map((c) => <li key={c}>{c}</li>) : <li>Look for anything odd, unclear or broken.</li>}
          </ul>
        </section>

        <ResultBox
          key={scenario.id}
          scenarioId={scenario.id}
          initialNote={draftsRef.current[scenario.id] ?? results[scenario.id]?.note ?? ""}
          draftsRef={draftsRef}
          advance={advance}
          onAdvance={setAdvance}
          onRecord={record}
        />

        <FaultPanel snap={snap} getControl={control} onSignedIn={() => frameRef.current?.contentWindow?.location.reload()} />
      </aside>
    </div>
  );
}

/** The scenario list. Only re-renders when the list, the selection or the results change. */
const ScenarioList = memo(/** @param {any} props */ function ScenarioList({ grouped, selectedId, results, onPick }) {
  return (
    <nav className="min-h-0 grow overflow-y-auto" aria-label="Scenarios">
      {grouped.map(([area, list]) => (
        <div key={area} className="mb-4">
          <h2 className="mb-1 font-mono text-sm">{area}</h2>
          <ul>
            {list.map((s) => {
              const st = results[s.id]?.status;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onPick(s.id)}
                    aria-current={s.id === selectedId}
                    className={`flex w-full items-center gap-2 rounded-pill px-3 py-1.5 text-left text-sm ${s.id === selectedId ? "surface-secondary" : ""}`}
                  >
                    <span aria-hidden className={`size-2 shrink-0 rounded-full ${st ? DOT[st] : "border border-accent"}`} />
                    <span className="truncate">{s.title}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
});

/** The note box and the result buttons. It owns the note while you type, so typing redraws only this. */
export function ResultBox({ scenarioId, initialNote, draftsRef, advance, onAdvance, onRecord }) {
  const [note, setNote] = useState(initialNote);
  const change = (value) => {
    setNote(value);
    draftsRef.current[scenarioId] = value;
  };
  return (
    <section className="flex flex-col gap-2">
      <textarea
        id="note-input"
        rows={3}
        className="rounded-large-element border border-accent bg-transparent p-3 text-sm focus:border-accent"
        placeholder="What went wrong? (saved with the result)"
        value={note}
        onChange={(e) => change(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" surface="primary" size="sm" onClick={() => onRecord("pass", note)}>Passed (P)</Button>
        <Button variant="accent" surface="primary" size="sm" disabled={!note.trim()} onClick={() => onRecord("fail", note)}>Problem</Button>
        <Button variant="outline" surface="primary" size="sm" onClick={() => onRecord("skip", note)}>Skip</Button>
        <Button variant="outline" surface="primary" size="sm" onClick={() => onRecord("retest", note)}>Fixed, retest</Button>
        <label className="flex w-full items-center gap-2 pt-1 text-xs">
          <input
            type="checkbox"
            checked={advance}
            onChange={(e) => {
              onAdvance(e.target.checked);
              try { localStorage.setItem("luna.statesAdvance", e.target.checked ? "on" : "off"); } catch { /* storage blocked */ }
            }}
          />
          Go to the next scenario after marking a result
        </label>
      </div>
    </section>
  );
}

const SIGNED_OUT = "__signed_out__";

/** Who the app is signed in as. Changing it reloads the app, keeping its data. */
function SignInAs({ snap, c, onSignedIn }) {
  const value = snap.sessionUserId ?? SIGNED_OUT;
  const people = snap.users;
  const hasMember = people.some((u) => u.role !== "admin");
  const change = (next) => {
    let id = next;
    if (next === "__new_member__") id = c.addMember();
    c.signInAs(id === SIGNED_OUT ? null : id);
    c.saveNow?.();
    onSignedIn();
  };
  return (
    <label className="flex items-center justify-between gap-2 text-sm">
      Sign in as
      <select className="rounded-pill border border-accent bg-transparent px-3 py-1" value={value} onChange={(e) => change(e.target.value)}>
        {people.map((u) => <option key={u.id} value={u.id}>{u.display_name || u.id} ({u.role === "admin" ? "Admin" : "Member"})</option>)}
        {!hasMember && <option value="__new_member__">A new Member with no access</option>}
        <option value={SIGNED_OUT}>Signed out</option>
      </select>
    </label>
  );
}

/** One line of the request log; click it to see the answer. */
function RequestRow({ l }) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button type="button" className="block w-full truncate text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {l.status || "…"} {l.method} {l.path}{l.note ? ` · ${l.note}` : ""}
      </button>
      {open && (
        <pre className="my-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-large-element p-2 surface-primary">
          {l.body || "(no body)"}
        </pre>
      )}
    </li>
  );
}

export const FaultPanel = memo(/** @param {any} props */ function FaultPanel({ snap, getControl, onSignedIn }) {
  const [match, setMatch] = useState("");
  const [mode, setMode] = useState("500");
  const [once, setOnce] = useState(false);
  const c = getControl();
  if (!snap || !c) return <p className="text-xs">The app is loading…</p>;
  const paths = [...new Set(snap.log.map((l) => `${l.method} ${l.path.split("?")[0]}`))].slice(0, 30);

  return (
    <section className="flex flex-col gap-3 rounded-large-element p-4 surface-secondary">
      <h2 className="font-mono text-base">Break things</h2>

      {snap.crashed.length > 0 && (
        <div role="alert" className="rounded-large-element border border-error/30 bg-error/20 p-2 text-xs">
          <p>The fake Luna itself crashed (a bug in the gallery, not in the app):</p>
          <ul className="mt-1 list-disc pl-4">
            {snap.crashed.map((x) => <li key={x.key}>fake crashed: {x.message} ({x.key} ×{x.count})</li>)}
          </ul>
        </div>
      )}

      {snap.unhandled.length > 0 && (
        <div role="alert" className="rounded-large-element border border-error/30 bg-error/20 p-2 text-xs">
          <p>The fake Luna has no answer for these (not a real bug, a missing mock):</p>
          <ul className="mt-1 list-disc pl-4">
            {snap.unhandled.map(([k, n]) => <li key={k}>{k} ×{n}</li>)}
          </ul>
        </div>
      )}

      <SignInAs snap={snap} c={c} onSignedIn={onSignedIn} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={snap.offline} onChange={(e) => c.setOffline(e.target.checked)} />
        Offline (every request fails)
      </label>
      <label className="flex items-center justify-between gap-2 text-sm">
        Slow everything
        <select className="rounded-pill border border-accent bg-transparent px-3 py-1" value={String(snap.latency)} onChange={(e) => c.setLatency(e.target.value)}>
          {LATENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <Button variant="outline" size="sm" onClick={() => c.expireSession()}>Expire the session</Button>

      <div className="flex flex-col gap-2 border-t border-accent pt-3">
        <p className="text-xs">Make one request fail. A rule matches that exact path; use * for any part, like /api/v1/drives/*/files.</p>
        <input list="recent-paths" className="rounded-pill border border-accent bg-transparent px-3 py-1.5 text-sm focus:border-accent" placeholder="e.g. POST /api/v1/users" value={match} onChange={(e) => setMatch(e.target.value)} />
        <datalist id="recent-paths">{paths.map((p) => <option key={p} value={p} />)}</datalist>
        <div className="flex items-center gap-2">
          <select className="grow rounded-pill border border-accent bg-transparent px-3 py-1.5 text-sm" value={mode} onChange={(e) => setMode(e.target.value)}>
            {FAULT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} />Once</label>
          <Button size="sm" disabled={!match.trim()} onClick={() => { c.addFault({ match: match.trim(), mode, once }); setMatch(""); }}>Add</Button>
        </div>
        <ul className="space-y-1 text-xs">
          {snap.faults.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2">
              <label className="flex min-w-0 items-center gap-2">
                <input type="checkbox" checked={f.on !== false} aria-label={`Rule ${f.match} is on`} onChange={(e) => c.setFaultOn(f.id, e.target.checked)} />
                <span className="truncate">{f.match} → {f.mode}{f.once ? " (once)" : ""} · caught {f.hits}</span>
              </label>
              <button type="button" className="underline" onClick={() => c.removeFault(f.id)}>Remove</button>
            </li>
          ))}
        </ul>
      </div>

      <details className="border-t border-accent pt-3">
        <summary className="cursor-pointer text-sm">Recent requests ({snap.log.length})</summary>
        <ul className="mt-2 max-h-56 space-y-0.5 overflow-y-auto text-xs">
          {snap.log.slice(0, 40).map((l, i) => <RequestRow key={`${l.t}-${i}`} l={l} />)}
        </ul>
      </details>
    </section>
  );
});
