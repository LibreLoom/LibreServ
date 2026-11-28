import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext";
import { getJson } from "../lib/api";

function renderAt(path, { setupCompleted = false, hasAdmin = false } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    if (u.endsWith("/api/v1/auth/me")) {
      return new Response("null", { status: 401 });
    }
    if (u.endsWith("/api/v1/auth/status")) {
      return new Response(JSON.stringify({ has_admin: hasAdmin }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/api/v1/setup")) {
      return new Response(JSON.stringify({ name: "Luna", setup_completed: setupCompleted }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<div>LUNA HOME</div>} />
          <Route path="/setup" element={<div>SETUP WIZARD</div>} />
          <Route path="/login" element={<div>LOGIN SCREEN</div>} />
          <Route path="/recover" element={<div>RECOVERY WIZARD</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

describe("AuthProvider setup gating", () => {
  afterEach(() => {
    // routeAfterRefresh reads window.location directly; MemoryRouter's own
    // path is irrelevant to it. Restore the tab for the next test.
    window.history.pushState({}, "", "/");
    vi.unstubAllGlobals();
  });

  it("sends a fresh Luna to the setup wizard", async () => {
    renderAt("/", { setupCompleted: false, hasAdmin: false });
    expect(await screen.findByText("SETUP WIZARD")).toBeInTheDocument();
  });

  it("sends a fresh Luna from login to the setup wizard", async () => {
    renderAt("/login", { setupCompleted: false, hasAdmin: false });
    expect(await screen.findByText("SETUP WIZARD")).toBeInTheDocument();
  });

  it("keeps password recovery reachable when Luna has no Admin yet", async () => {
    renderAt("/recover", { setupCompleted: false, hasAdmin: false });
    expect(await screen.findByText("RECOVERY WIZARD")).toBeInTheDocument();
  });

  it("stays on /recover/ when the startup read finds no Admin", async () => {
    // The router matches /recover and /recover/ as the same route, but the
    // startup decision read window.location.pathname literally. With a
    // trailing slash it looked like an unknown route and was replaced by the
    // setup wizard, so recovery was unreachable at /recover/.
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) return new Response("null", { status: 401 });
      if (u.endsWith("/api/v1/auth/status")) {
        return new Response(JSON.stringify({ has_admin: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/api/v1/setup")) {
        return new Response(JSON.stringify({ name: "Luna", setup_completed: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }));
    window.history.pushState({}, "", "/recover/");

    function Probe() {
      const { loading } = useAuth();
      const { pathname } = useLocation();
      return (
        <div>
          <span>{loading ? "LOADING" : "READY"}</span>
          <span>{`AT ${pathname}`}</span>
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={["/recover/"]}>
        <AuthProvider>
          <Probe />
          <Routes>
            <Route path="/recover" element={<div>RECOVERY WIZARD</div>} />
            <Route path="/setup" element={<div>SETUP WIZARD</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    // Wait for the read to land: checking the route before then would pass
    // even if the decision later replaces recovery with the wizard.
    expect(await screen.findByText("READY")).toBeInTheDocument();
    expect(screen.getByText("AT /recover/")).toBeInTheDocument();
    expect(screen.getByText("RECOVERY WIZARD")).toBeInTheDocument();
    expect(screen.queryByText("SETUP WIZARD")).not.toBeInTheDocument();
  });

  it("stays on /RECOVER/ when the startup read finds no Admin", async () => {
    // React Router matches /RECOVER/ to the /recover route (case-insensitive,
    // trailing slash ignored), but normalizePath used to preserve case. The
    // startup decision then saw an unknown route and replaced recovery with
    // the setup wizard, so recovery was unreachable at /RECOVER/.
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) return new Response("null", { status: 401 });
      if (u.endsWith("/api/v1/auth/status")) {
        return new Response(JSON.stringify({ has_admin: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/api/v1/setup")) {
        return new Response(JSON.stringify({ name: "Luna", setup_completed: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }));
    window.history.pushState({}, "", "/RECOVER/");

    function Probe() {
      const { loading } = useAuth();
      const { pathname } = useLocation();
      return (
        <div>
          <span>{loading ? "LOADING" : "READY"}</span>
          <span>{`AT ${pathname}`}</span>
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={["/RECOVER/"]}>
        <AuthProvider>
          <Probe />
          <Routes>
            <Route path="/recover" element={<div>RECOVERY WIZARD</div>} />
            <Route path="/setup" element={<div>SETUP WIZARD</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    // Wait for the read to land: checking the route before then would pass
    // even if the decision later replaces recovery with the wizard.
    expect(await screen.findByText("READY")).toBeInTheDocument();
    expect(screen.getByText("AT /RECOVER/")).toBeInTheDocument();
    expect(screen.getByText("RECOVERY WIZARD")).toBeInTheDocument();
    expect(screen.queryByText("SETUP WIZARD")).not.toBeInTheDocument();
  });

  it("stays on /%72ecover/ when the startup read finds no Admin", async () => {
    // React Router decodes percent escapes when matching, so /%72ecover/ is
    // the /recover route. The startup decision compared the raw pathname, saw
    // an unknown route and replaced recovery with the setup wizard.
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) return new Response("null", { status: 401 });
      if (u.endsWith("/api/v1/auth/status")) {
        return new Response(JSON.stringify({ has_admin: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/api/v1/setup")) {
        return new Response(JSON.stringify({ name: "Luna", setup_completed: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }));
    window.history.pushState({}, "", "/%72ecover/");

    function Probe() {
      const { loading } = useAuth();
      const { pathname } = useLocation();
      return (
        <div>
          <span>{loading ? "LOADING" : "READY"}</span>
          <span>{`AT ${pathname}`}</span>
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={["/%72ecover/"]}>
        <AuthProvider>
          <Probe />
          <Routes>
            <Route path="/recover" element={<div>RECOVERY WIZARD</div>} />
            <Route path="/setup" element={<div>SETUP WIZARD</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    // Wait for the read to land: checking the route before then would pass
    // even if the decision later replaces recovery with the wizard.
    expect(await screen.findByText("READY")).toBeInTheDocument();
    expect(screen.getByText("AT /%72ecover/")).toBeInTheDocument();
    expect(screen.getByText("RECOVERY WIZARD")).toBeInTheDocument();
    expect(screen.queryByText("SETUP WIZARD")).not.toBeInTheDocument();
  });

  it("keeps login when setup is incomplete but an account exists", async () => {
    renderAt("/login", { setupCompleted: false, hasAdmin: true });
    expect(await screen.findByText("LOGIN SCREEN")).toBeInTheDocument();
  });

  it("leaves a set-up Luna on its page", async () => {
    renderAt("/", { setupCompleted: true, hasAdmin: true });
    expect(await screen.findByText("LUNA HOME")).toBeInTheDocument();
  });

  it("sends to setup wizard when /setup endpoint fails and hasAdmin is false", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) return new Response("null", { status: 401 });
      if (u.endsWith("/api/v1/auth/status")) {
        return new Response(JSON.stringify({ has_admin: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/api/v1/setup")) {
        return new Response("{}", { status: 500 });
      }
      return new Response("{}", { status: 404 });
    }));
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<div>LUNA HOME</div>} />
            <Route path="/setup" element={<div>SETUP WIZARD</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
    expect(await screen.findByText("SETUP WIZARD")).toBeInTheDocument();
  });
});

describe("AuthProvider session survival", () => {
  it("keeps the user signed in after login and in-app navigation", async () => {
    // /auth/me behaves like the pre-fix backend: it ALWAYS reports "not
    // signed in", even with a fresh session. The fix is that the startup
    // effect must not re-run on navigation (useNavigate's identity changes
    // per route), so the stale me read can never wipe a fresh login.
    const meCalls = { n: 0 };
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) {
        meCalls.n += 1;
        return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (u.endsWith("/api/v1/auth/status")) {
        return new Response(JSON.stringify({ has_admin: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/api/v1/setup")) {
        return new Response(JSON.stringify({ name: "Luna", setup_completed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/api/v1/auth/login") && options.method === "POST") {
        return new Response(JSON.stringify({ id: "1", username: "max", role: "admin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }));

    function LoginAndGo() {
      const { login } = useAuth();
      const navigate = useNavigate();
      return (
        <button
          onClick={() => {
            login("max", "hunter22hunter").then(() => navigate("/files"));
          }}
        >
          LOGIN AND GO
        </button>
      );
    }

    function Drives() {
      const { user } = useAuth();
      return <div>{user ? `SIGNED IN AS ${user.username}` : "NOT SIGNED IN"}</div>;
    }

    render(
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginAndGo />} />
            <Route path="/files" element={<Drives />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("button", { name: "LOGIN AND GO" }));
    expect(await screen.findByText("SIGNED IN AS max")).toBeInTheDocument();
    // The startup me read happens once; in-app navigation must not re-run it.
    expect(meCalls.n).toBe(1);
  });
});

describe("AuthProvider session ending mid-use", () => {
  function renderSignedIn({ sessionStillValid }) {
    let signedIn = true;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      const json = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.endsWith("/api/v1/auth/me")) {
        return json(signedIn ? { id: "u1", username: "ada", role: "admin" } : null);
      }
      if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
      if (u.endsWith("/api/v1/setup")) return json({ name: "Luna", setup_completed: true });
      if (u.endsWith("/api/v1/users")) {
        if (!sessionStillValid) signedIn = false;
        return json({ error: "Sign in to Luna first." }, 401);
      }
      return json({}, 404);
    }));

    function Probe() {
      const { user, sessionEnded, loading } = useAuth();
      if (loading) return null;
      return (
        <div>
          <span>{user ? `USER ${user.username}` : "NO USER"}</span>
          {sessionEnded && <span>SESSION ENDED</span>}
          <button type="button" onClick={() => getJson("/api/v1/users").catch(() => {})}>LOAD</button>
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    );
  }

  it("signs the user out when a 401 turns out to be a dead session", async () => {
    renderSignedIn({ sessionStillValid: false });
    fireEvent.click(await screen.findByText("LOAD"));
    expect(await screen.findByText("NO USER")).toBeInTheDocument();
    expect(screen.getByText("SESSION ENDED")).toBeInTheDocument();
  });

  it("keeps the user when the session is still valid after a 401", async () => {
    renderSignedIn({ sessionStillValid: true });
    fireEvent.click(await screen.findByText("LOAD"));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("USER ada")).toBeInTheDocument();
    expect(screen.queryByText("SESSION ENDED")).not.toBeInTheDocument();
  });
});

describe("AuthProvider endSession", () => {
  it("clears the user without moving off the current URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      const json = (body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.endsWith("/api/v1/auth/me")) return json({ id: "u1", username: "ada", role: "admin" });
      if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
      if (u.endsWith("/api/v1/setup")) return json({ name: "Luna", setup_completed: true });
      return json({}, 404);
    }));

    function Probe() {
      const { user, loading, endSession } = useAuth();
      const { pathname } = useLocation();
      if (loading) return null;
      return (
        <div>
          <span>{user ? `USER ${user.username}` : "NO USER"}</span>
          <span>AT {pathname}</span>
          <button type="button" onClick={endSession}>END</button>
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <AuthProvider>
          <Routes>
            <Route path="/settings" element={<Probe />} />
            <Route path="/login" element={<div>LOGIN ROUTE</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    expect(await screen.findByText("USER ada")).toBeInTheDocument();
    fireEvent.click(screen.getByText("END"));
    expect(await screen.findByText("NO USER")).toBeInTheDocument();
    // The tab stays put; RequireAuth is what shows the sign-in form in place.
    expect(screen.getByText("AT /settings")).toBeInTheDocument();
    expect(screen.queryByText("LOGIN ROUTE")).not.toBeInTheDocument();
  });
});

describe("AuthProvider when Luna is unreachable", () => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  // What a Luna restarting after an update looks like: every request fails.
  function allRequestsFail() {
    return vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
  }

  function renderApp() {
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<div>LUNA HOME</div>} />
            <Route path="/setup" element={<div>SETUP WIZARD</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
  }

  it("starts on the page it was on, not the setup wizard, when every request fails", async () => {
    vi.stubGlobal("fetch", allRequestsFail());

    function Probe() {
      const { loading, setup, hasAdmin } = useAuth();
      const { pathname } = useLocation();
      return (
        <div>
          <span>{`AT ${pathname}`}</span>
          <span>{loading ? "LOADING" : "READY"}</span>
          <span>{`SETUP ${setup ? setup.setup_completed : "UNKNOWN"}`}</span>
          <span>{`ADMIN ${hasAdmin === null ? "UNKNOWN" : hasAdmin}`}</span>
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider>
          <Probe />
          <Routes>
            <Route path="/" element={null} />
            <Route path="/setup" element={<div>SETUP WIZARD</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    // Wait for the bootstrap to finish, then check it moved nobody anywhere
    // and invented no state: a restart is not a fresh Luna.
    expect(await screen.findByText("READY")).toBeInTheDocument();
    expect(screen.getByText("AT /")).toBeInTheDocument();
    expect(screen.queryByText("SETUP WIZARD")).not.toBeInTheDocument();
    expect(screen.getByText("SETUP UNKNOWN")).toBeInTheDocument();
    expect(screen.getByText("ADMIN UNKNOWN")).toBeInTheDocument();
  });

  it("keeps the setup state it already had when a later refresh finds Luna unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) return json(null, 401);
      if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
      if (u.endsWith("/api/v1/setup")) return json({ name: "Luna", setup_completed: true });
      return json({}, 404);
    }));

    function Probe() {
      const { setup, hasAdmin, loading, refresh } = useAuth();
      const [last, setLast] = useState(null);
      if (loading) return null;
      return (
        <div>
          <span>{`SETUP ${setup ? setup.setup_completed : "UNKNOWN"}`}</span>
          <span>{`ADMIN ${hasAdmin === null ? "UNKNOWN" : hasAdmin}`}</span>
          <span>{`LAST ${last ? (last.unreachable ? "UNREACHABLE" : "ANSWERED") : "NONE"}`}</span>
          <button type="button" onClick={async () => setLast(await refresh())}>REFRESH</button>
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(await screen.findByText("SETUP true")).toBeInTheDocument();
    expect(screen.getByText("ADMIN true")).toBeInTheDocument();

    // Luna restarts: every request now fails. The known state must survive.
    vi.stubGlobal("fetch", allRequestsFail());
    fireEvent.click(screen.getByText("REFRESH"));
    expect(await screen.findByText("LAST UNREACHABLE")).toBeInTheDocument();
    expect(screen.getByText("SETUP true")).toBeInTheDocument();
    expect(screen.getByText("ADMIN true")).toBeInTheDocument();
  });

  it("still sends a fresh Luna to setup when /auth/status says there is no Admin", async () => {
    // Only /auth/status answers — the other two fail. One real answer is
    // enough to know this is a fresh Luna, so the wizard is correct here.
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: false });
      throw new TypeError("Failed to fetch");
    }));
    renderApp();
    expect(await screen.findByText("SETUP WIZARD")).toBeInTheDocument();
    expect(screen.queryByText("LUNA HOME")).not.toBeInTheDocument();
  });

  it("infers an existing Admin when only /auth/status is unreachable", async () => {
    // The fallback from before this fix: a completed setup means an account
    // exists, so a failed /auth/status must not read as a fresh Luna.
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) return json(null, 401);
      if (u.endsWith("/api/v1/setup")) return json({ name: "Luna", setup_completed: true });
      throw new TypeError("Failed to fetch");
    }));
    renderApp();
    expect(await screen.findByText("LUNA HOME")).toBeInTheDocument();
    expect(screen.queryByText("SETUP WIZARD")).not.toBeInTheDocument();
  });
});

describe("AuthProvider recovery poll", () => {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("treats any HTTP answer as recovery and never overlaps two ticks", async () => {
    vi.useFakeTimers();
    let online = false;
    /** @type {(value?: any) => void} */
    let releaseMe = () => {};
    const meGate = new Promise((resolve) => { releaseMe = resolve; });
    let meCalls = 0;

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (!online) throw new TypeError("Failed to fetch");
      if (u.endsWith("/api/v1/auth/me")) {
        meCalls += 1;
        await meGate; // hold the answer across a whole interval tick
        return new Response("null", { status: 401 });
      }
      if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
      if (u.endsWith("/api/v1/setup")) return json({ name: "Luna", setup_completed: true });
      return json({}, 404);
    }));

    function Probe() {
      const { loading, unreachable } = useAuth();
      return <div>{loading ? "LOADING" : unreachable ? "UNREACHABLE" : "REACHABLE"}</div>;
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider><Probe /></AuthProvider>
      </MemoryRouter>
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("UNREACHABLE")).toBeTruthy();

    // Luna is back but /auth/me answers 401: that is still an HTTP answer.
    online = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(meCalls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(meCalls).toBe(1); // in-flight guard: no second poll on top of the first

    await act(async () => { releaseMe(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("REACHABLE")).toBeTruthy();
    // One completed tick makes two /auth/me calls: the poll's apiFetch probe,
    // then refresh()'s own getJson. Both got the gated 401 from the stub.
    expect(meCalls).toBe(2);

    // Recovery cleared the timer: four more intervals must add no calls.
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(meCalls).toBe(2);
  });

  it("also recovers when /auth/me answers 500", async () => {
    vi.useFakeTimers();
    let online = false;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (!online) throw new TypeError("Failed to fetch");
      if (u.endsWith("/api/v1/auth/me")) return new Response("{}", { status: 500 });
      if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
      if (u.endsWith("/api/v1/setup")) return json({ name: "Luna", setup_completed: true });
      return json({}, 404);
    }));

    function Probe() {
      const { loading, unreachable } = useAuth();
      return <div>{loading ? "LOADING" : unreachable ? "UNREACHABLE" : "REACHABLE"}</div>;
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider><Probe /></AuthProvider>
      </MemoryRouter>
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("UNREACHABLE")).toBeTruthy();

    online = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText("REACHABLE")).toBeTruthy();
  });

  it("retries recovery after a blackholed probe times out", async () => {
    vi.useFakeTimers();
    let online = false;
    let probeCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      const u = String(url);
      if (!online) throw new TypeError("Failed to fetch");
      if (u.endsWith("/api/v1/auth/me")) {
        // The probe passes `cache: "no-store"`; refresh() now passes a signal
        // too, so the signal alone no longer identifies it. Blackhole the first
        // probe and ignore its abort, so only the deadline (not fetch) can free
        // the in-flight guard.
        if (options?.cache === "no-store") {
          probeCalls += 1;
          if (probeCalls === 1) return new Promise(() => {});
        }
        return new Response("null", { status: 401 });
      }
      if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
      if (u.endsWith("/api/v1/setup")) return json({ name: "Luna", setup_completed: true });
      return json({}, 404);
    }));

    function Probe() {
      const { loading, unreachable } = useAuth();
      return <div>{loading ? "LOADING" : unreachable ? "UNREACHABLE" : "REACHABLE"}</div>;
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider><Probe /></AuthProvider>
      </MemoryRouter>
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("UNREACHABLE")).toBeTruthy();

    online = true;
    // First tick starts a probe that never answers. The guard keeps later
    // ticks from stacking on top of it.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(probeCalls).toBe(1);
    expect(screen.getByText("UNREACHABLE")).toBeTruthy();

    // The deadline fires 5 s into the probe: it aborts the socket and frees
    // the guard even though the stubbed fetch ignores the abort.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(probeCalls).toBe(1);
    expect(screen.getByText("UNREACHABLE")).toBeTruthy();

    // The next interval tick retries. Without the timeout this never happens.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(probeCalls).toBe(2);
    expect(screen.getByText("REACHABLE")).toBeTruthy();

    // Recovery cleared the interval and deadline: no further probes.
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(probeCalls).toBe(2);
  });

  it("a prompt probe with a stalled refresh is invalidated at the deadline, then a later tick recovers", async () => {
    // Regression: the probe used to be the only request carrying a signal, so
    // a hung refresh kept running after the race rejected. Its later response
    // could overwrite state committed by a newer attempt.
    vi.useFakeTimers();
    let online = false;
    let staleResolved = false;
    /** @type {(value?: any) => void} */
    let releaseFirstRefresh = () => {};
    const firstRefreshGate = new Promise((resolve) => { releaseFirstRefresh = resolve; });
    let refreshMeCalls = 0;
    /** @type {{ me?: AbortSignal, setup?: AbortSignal, status?: AbortSignal } | null} */
    let firstRefreshSignals = null;

    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const u = String(url);
      if (!online) throw new TypeError("Failed to fetch");
      if (u.endsWith("/api/v1/auth/me")) {
        // The probe has `cache: "no-store"`; all three refresh requests carry
        // the attempt's signal. Stall only the first recovery refresh and
        // ignore its abort so only the deadline frees the in-flight guard.
        if (options?.cache === "no-store") return new Response("null", { status: 401 });
        refreshMeCalls += 1;
        if (refreshMeCalls === 1) {
          firstRefreshSignals = { me: options?.signal };
          await firstRefreshGate;
          staleResolved = true;
          return json({ id: "old", username: "old", role: "user" });
        }
        return json({ id: "u2", username: "ada", role: "admin" });
      }
      if (u.endsWith("/api/v1/auth/status")) {
        if (staleResolved && firstRefreshSignals) firstRefreshSignals.status = options?.signal;
        return json({ has_admin: !staleResolved });
      }
      if (u.endsWith("/api/v1/setup")) {
        if (staleResolved && firstRefreshSignals) firstRefreshSignals.setup = options?.signal;
        return json({ name: "Luna", setup_completed: !staleResolved });
      }
      return json({}, 404);
    }));

    function Probe() {
      const { loading, unreachable, user, setup, hasAdmin } = useAuth();
      return (
        <div>
          <span>{loading ? "LOADING" : unreachable ? "UNREACHABLE" : "REACHABLE"}</span>
          <span>{`USER ${user ? user.username : "NONE"}`}</span>
          <span>{`SETUP ${setup ? setup.setup_completed : "UNKNOWN"}`}</span>
          <span>{`ADMIN ${hasAdmin === null ? "UNKNOWN" : hasAdmin}`}</span>
        </div>
      );
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider><Probe /></AuthProvider>
      </MemoryRouter>
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("UNREACHABLE")).toBeTruthy();
    expect(screen.getByText("USER NONE")).toBeTruthy();
    expect(screen.getByText("SETUP UNKNOWN")).toBeTruthy();
    expect(screen.getByText("ADMIN UNKNOWN")).toBeTruthy();

    online = true;
    // Probe answers at once; refresh's /auth/me hangs across the interval.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(refreshMeCalls).toBe(1);
    expect(firstRefreshSignals?.me).toBeTruthy();
    expect(screen.getByText("UNREACHABLE")).toBeTruthy();

    // Deadline: the attempt's signal is aborted, so no state may be committed
    // from the stalled refresh, and the in-flight guard is freed.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(firstRefreshSignals?.me?.aborted).toBe(true);
    expect(screen.getByText("UNREACHABLE")).toBeTruthy();
    expect(screen.getByText("USER NONE")).toBeTruthy();
    expect(screen.getByText("SETUP UNKNOWN")).toBeTruthy();
    expect(screen.getByText("ADMIN UNKNOWN")).toBeTruthy();

    // Next tick recovers with fast answers: the newer attempt owns the state.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(refreshMeCalls).toBe(2);
    expect(screen.getByText("REACHABLE")).toBeTruthy();
    expect(screen.getByText("USER ada")).toBeTruthy();
    expect(screen.getByText("SETUP true")).toBeTruthy();
    expect(screen.getByText("ADMIN true")).toBeTruthy();

    // The stale refresh finally resolves with different data. Its signal (the
    // same one threaded to /setup and /auth/status) was aborted, so it must not
    // replace the state the newer tick just committed.
    await act(async () => { releaseFirstRefresh(); await vi.advanceTimersByTimeAsync(0); });
    expect(firstRefreshSignals?.setup).toBe(firstRefreshSignals?.me);
    expect(firstRefreshSignals?.status).toBe(firstRefreshSignals?.me);
    expect(screen.getByText("USER ada")).toBeTruthy();
    expect(screen.getByText("SETUP true")).toBeTruthy();
    expect(screen.getByText("ADMIN true")).toBeTruthy();
  });

  it("a stale refresh cannot overwrite a newer login", async () => {
    vi.useFakeTimers();
    let online = false;
    let staleResolved = false;
    /** @type {(value?: any) => void} */
    let releaseFirstRefresh = () => {};
    const firstRefreshGate = new Promise((resolve) => { releaseFirstRefresh = resolve; });
    let refreshMeCalls = 0;
    let probeCalls = 0;

    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const u = String(url);
      if (!online) throw new TypeError("Failed to fetch");
      if (u.endsWith("/api/v1/auth/me")) {
        if (options?.cache === "no-store") {
          probeCalls += 1;
          // The first probe answers; later ones hang so no competing refresh
          // completes after the login.
          return probeCalls === 1
            ? new Response("null", { status: 401 })
            : new Promise(() => {});
        }
        refreshMeCalls += 1;
        if (refreshMeCalls === 1) {
          await firstRefreshGate;
          staleResolved = true;
          return json({ id: "old", username: "old" });
        }
        return json({ id: "other", username: "other" });
      }
      if (u.endsWith("/api/v1/auth/login")) {
        return json({ id: "new", username: "newuser", role: "admin" });
      }
      if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: !staleResolved });
      if (u.endsWith("/api/v1/setup")) return json({ name: "Luna", setup_completed: !staleResolved });
      return json({}, 404);
    }));

    function Probe() {
      const { loading, user, setup, hasAdmin, login } = useAuth();
      return (
        <div>
          <span>{loading ? "LOADING" : "READY"}</span>
          <span>{`USER ${user ? user.username : "NONE"}`}</span>
          <span>{`SETUP ${setup ? setup.setup_completed : "UNKNOWN"}`}</span>
          <span>{`ADMIN ${hasAdmin === null ? "UNKNOWN" : hasAdmin}`}</span>
          <button type="button" onClick={() => login("newuser", "pw").catch(() => {})}>LOGIN</button>
        </div>
      );
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider><Probe /></AuthProvider>
      </MemoryRouter>
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("READY")).toBeTruthy();
    expect(screen.getByText("SETUP UNKNOWN")).toBeTruthy();

    online = true;
    // First tick: probe answers, refresh stalls, deadline frees the guard.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(refreshMeCalls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    // Next tick's probe hangs, so no other refresh can commit.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await act(async () => { fireEvent.click(screen.getByText("LOGIN")); });
    expect(screen.getByText("USER newuser")).toBeTruthy();
    expect(screen.getByText("SETUP UNKNOWN")).toBeTruthy();
    expect(screen.getByText("ADMIN UNKNOWN")).toBeTruthy();

    // The aborted refresh resolves with old user and stale setup/admin data.
    // None of it may replace the newer login.
    await act(async () => { releaseFirstRefresh(); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("USER newuser")).toBeTruthy();
    expect(screen.getByText("SETUP UNKNOWN")).toBeTruthy();
    expect(screen.getByText("ADMIN UNKNOWN")).toBeTruthy();
  });

  it("starts recovery when the startup refresh passes its deadline", async () => {
    // A blackholed /auth/me on first load used to leave the app loading with
    // no recovery poll. The startup read must carry a signal and a deadline.
    vi.useFakeTimers();
    let meCalls = 0;
    /** @type {AbortSignal | null} */
    let startupSignal = null;
    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) {
        meCalls += 1;
        if (meCalls === 1) {
          // Ignore the abort so only the deadline can end the startup read.
          startupSignal = options?.signal || null;
          return new Promise(() => {});
        }
        return new Response("null", { status: 401 });
      }
      if (u.endsWith("/api/v1/auth/status")) return json({ has_admin: true });
      if (u.endsWith("/api/v1/setup")) return json({ name: "Luna", setup_completed: true });
      return json({}, 404);
    }));

    function Probe() {
      const { loading, unreachable } = useAuth();
      return <div>{loading ? "LOADING" : unreachable ? "UNREACHABLE" : "REACHABLE"}</div>;
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider><Probe /></AuthProvider>
      </MemoryRouter>
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("LOADING")).toBeTruthy();
    expect(startupSignal).toBeTruthy();
    expect(startupSignal?.aborted).toBe(false);
    expect(meCalls).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(startupSignal?.aborted).toBe(true);
    expect(screen.getByText("UNREACHABLE")).toBeTruthy();

    // The recovery interval now runs: the next tick's probe and refresh both
    // call /auth/me, and the first answer clears the unreachable notice.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(meCalls).toBe(3);
    expect(screen.getByText("REACHABLE")).toBeTruthy();
  });

  it("a stale recovery answer released before the deadline cannot clear a newer login", async () => {
    // The old regression waited for the deadline before signing in. This one
    // releases the stale setup/status answer BEFORE the deadline, after login.
    vi.useFakeTimers();
    let online = false;
    let stallTail = false;
    /** @type {(value?: any) => void} */
    let releaseTail = () => {};
    const tailGate = new Promise((resolve) => { releaseTail = resolve; });
    let probeCalls = 0;
    let refreshMeCalls = 0;
    /** @type {AbortSignal | null} */
    let staleSignal = null;

    vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
      const u = String(url);
      if (!online) throw new TypeError("Failed to fetch");
      if (u.endsWith("/api/v1/auth/me")) {
        if (options?.cache === "no-store") {
          probeCalls += 1;
          return new Response("null", { status: 401 });
        }
        refreshMeCalls += 1;
        if (refreshMeCalls === 1) {
          staleSignal = options?.signal || null;
          // A clean 200 with null body: without the fix this clears the user.
          return json(null);
        }
        return json({ id: "other", username: "other" });
      }
      if (u.endsWith("/api/v1/auth/login")) {
        return json({ id: "new", username: "newuser", role: "admin" });
      }
      if (u.endsWith("/api/v1/auth/status")) {
        if (stallTail) await tailGate;
        return json({ has_admin: false }); // stale: looks like a fresh Luna
      }
      if (u.endsWith("/api/v1/setup")) {
        if (stallTail) await tailGate;
        return json({ name: "Luna", setup_completed: false });
      }
      return json({}, 404);
    }));

    function Probe() {
      const { loading, user, login } = useAuth();
      const { pathname } = useLocation();
      return (
        <div>
          <span>{`AT ${pathname}`}</span>
          <span>{loading ? "LOADING" : "READY"}</span>
          <span>{`USER ${user ? user.username : "NONE"}`}</span>
          <button type="button" onClick={() => login("newuser", "pw").catch(() => {})}>LOGIN</button>
        </div>
      );
    }
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AuthProvider>
          <Probe />
          <Routes>
            <Route path="/" element={<div>HOME PAGE</div>} />
            <Route path="/setup" element={<div>SETUP WIZARD</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("READY")).toBeTruthy();
    expect(screen.getByText("AT /")).toBeTruthy();

    online = true;
    stallTail = true;
    // First tick: probe and refresh both read "nobody signed in", but the
    // refresh's setup/status answers are held back, so it has not committed.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(probeCalls).toBe(1);
    expect(refreshMeCalls).toBe(1);
    expect(staleSignal?.aborted).toBe(false);
    expect(screen.getByText("USER NONE")).toBeTruthy();

    // Login wins the race to own the session. No deadline has fired yet.
    await act(async () => { fireEvent.click(screen.getByText("LOGIN")); });
    expect(screen.getByText("USER newuser")).toBeTruthy();

    // Release the stale answer before the deadline. The old refresh resolves
    // with `me: null` and "no Admin" data; it must not clear the new user or
    // send the tab to the setup wizard.
    await act(async () => { releaseTail(); await vi.advanceTimersByTimeAsync(0); });
    expect(staleSignal?.aborted).toBe(true); // login aborted it, not the deadline
    expect(screen.getByText("USER newuser")).toBeTruthy();
    expect(screen.getByText("AT /")).toBeTruthy();
    expect(screen.queryByText("SETUP WIZARD")).not.toBeTruthy();
  });
});

describe("AuthProvider routing while the startup read is pending", () => {
  afterEach(() => {
    // jsdom keeps location between tests; put the tab back where the rest of
    // the suite expects it (MemoryRouter's own path is unrelated to this).
    window.history.pushState({}, "", "/");
    vi.unstubAllGlobals();
  });

  it("stays on /recover when a pending startup read resolves with no Admin after the person navigated there", async () => {
    // Regression: the startup effect captured window.location.pathname once,
    // so a read that began on /login and landed after the person opened the
    // recovery form routed by the stale "/login" and replaced recovery with
    // the setup wizard. The routing decision must read the current path.
    /** @type {(value?: any) => void} */
    let releaseMe = () => {};
    const meGate = new Promise((resolve) => { releaseMe = resolve; });
    let meCalls = 0;

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith("/api/v1/auth/me")) {
        meCalls += 1;
        if (meCalls === 1) await meGate; // hold the startup read open
        return new Response("null", { status: 401 });
      }
      if (u.endsWith("/api/v1/auth/status")) {
        return new Response(JSON.stringify({ has_admin: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.endsWith("/api/v1/setup")) {
        return new Response(JSON.stringify({ name: "Luna", setup_completed: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    }));

    // The browser tab starts on /login, which is what the startup read sees.
    window.history.pushState({}, "", "/login");

    function NavToRecover() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate("/recover")}>
          OPEN RECOVERY
        </button>
      );
    }
    function Probe() {
      const { loading } = useAuth();
      const { pathname } = useLocation();
      return (
        <div>
          <span>{loading ? "LOADING" : "READY"}</span>
          <span>{`AT ${pathname}`}</span>
        </div>
      );
    }

    render(
      <MemoryRouter initialEntries={["/login"]}>
        <AuthProvider>
          <NavToRecover />
          <Probe />
          <Routes>
            <Route path="/login" element={<div>LOGIN SCREEN</div>} />
            <Route path="/recover" element={<div>RECOVERY WIZARD</div>} />
            <Route path="/setup" element={<div>SETUP WIZARD</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    // Open the recovery form while the startup read is still held open. Mirror
    // the browser URL the way a real link in a BrowserRouter would, since
    // MemoryRouter keeps its path in memory only.
    await act(async () => { fireEvent.click(screen.getByText("OPEN RECOVERY")); });
    window.history.pushState({}, "", "/recover");
    expect(screen.getByText("RECOVERY WIZARD")).toBeInTheDocument();

    // The held read now lands with no Admin and nobody signed in.
    await act(async () => { releaseMe(); });
    expect(await screen.findByText("READY")).toBeInTheDocument();
    expect(screen.getByText("AT /recover")).toBeInTheDocument();
    expect(screen.getByText("RECOVERY WIZARD")).toBeInTheDocument();
    expect(screen.queryByText("SETUP WIZARD")).not.toBeInTheDocument();
  });
});
