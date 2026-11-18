import { afterEach, describe, expect, it, vi } from "vitest";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function load(url, routes) {
  window.history.replaceState(null, "", url);
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      const u = String(input);
      calls.push(u);
      const hit = Object.keys(routes).find((k) => u.includes(k));
      return hit ? routes[hit]() : new Response("", { status: 404 });
    }),
  );
  vi.resetModules();
  const mod = await import("./shareEarly.js");
  mod.startShareEarly();
  return { mod, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("startShareEarly", () => {
  it("asks for a folder link's meta and listing before the share page loads", async () => {
    const { mod, calls } = await load("/s/tok1?path=a", {
      "/s/tok1/list": () => json({ entries: [{ name: "x.txt" }] }),
      "/s/tok1?meta=1": () => json({ kind: "folder", caps: "view" }),
    });
    const res = await mod.takeEarlyShareMeta("tok1");
    expect(await res.json()).toEqual({ kind: "folder", caps: "view" });
    expect(mod.takeEarlyShareMeta("tok1")).toBeNull();
    expect(mod.takeEarlyShareList("tok1", "")).toBeNull();
    expect(await mod.takeEarlyShareList("tok1", "a")).toEqual([{ name: "x.txt" }]);
    expect(calls.some((u) => u.includes("/s/tok1/list?path=a"))).toBe(true);
  });

  it("sends nothing extra for a link that needs a password", async () => {
    const { mod, calls } = await load("/s/tok2", {
      "/s/tok2?meta=1": () => json({ error: "password" }, 401),
    });
    expect((await mod.takeEarlyShareMeta("tok2")).status).toBe(401);
    expect(await mod.takeEarlyShareList("tok2", "")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("does nothing outside a share link", async () => {
    const { mod, calls } = await load("/photos", {});
    expect(mod.takeEarlyShareMeta("tok1")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
