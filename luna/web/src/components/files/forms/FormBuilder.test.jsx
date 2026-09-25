import { describe, expect, it, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FormBuilder from "./FormBuilder.jsx";
import { driveSource, FileSourceProvider, shareSource } from "../../../lib/fileSource.jsx";

// Guest saves go through chunked upload — putBinaryProgress is XHR-based
// and unreachable in jsdom, so resolve it like a complete chunk would.
vi.mock("../../../lib/api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  putBinaryProgress: vi.fn(async () => ({ received: 4 })),
}));

const FORM_DOC = JSON.stringify({
  version: 1,
  title: "Family reunion RSVP",
  settings: { collecting: true, allowEdits: true },
  questions: [
    { v: 1, id: "q_1", type: "short_text", label: "Your name?", required: true, config: {} },
  ],
});

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function mountBuilder({ source = driveSource, canWrite = true } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const reg = { save: /** @type {null | (() => Promise<unknown>)} */ (null) };
  render(
    <QueryClientProvider client={qc}>
      <FileSourceProvider source={source}>
        <FormBuilder
          driveId="d1"
          path="rsvp.lunaform"
          name="rsvp.lunaform"
          canWrite={canWrite}
          onRegisterSave={(f) => { reg.save = f; }}
          onSaveStateChange={() => {}}
        />
      </FileSourceProvider>
    </QueryClientProvider>,
  );
  return reg;
}

function stubFetch(handler) {
  const calls = /** @type {[string, string][]} */ ([]);
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    const u = String(url);
    const m = /** @type {string} */ (init.method || "GET").toUpperCase();
    calls.push([u, m]);
    return handler(u, m);
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FormBuilder drive source", () => {
  it("loads through the member APIs and saves through the upload route", async () => {
    const calls = stubFetch((u, m) => {
      if (u.includes("/files/content")) return new Response(FORM_DOC, { status: 200 });
      if (u.includes("/api/v1/forms/responses")) {
        return json({ responses: [{ id: "r1", answers: { q_1: "Ann" } }] });
      }
      if (u.includes("/files/upload") && m === "POST") return json({ name: "rsvp.lunaform" });
      return json({}, 404);
    });
    const reg = mountBuilder();

    const title = await screen.findByLabelText("Form title");
    expect(title).toHaveValue("Family reunion RSVP");
    expect(
      calls.some(([u]) => u.includes("/api/v1/forms/responses?drive_id=d1&path=rsvp.lunaform")),
    ).toBe(true);
    // Members still get the share affordance.
    expect(screen.getByRole("button", { name: "Share this form" })).toBeInTheDocument();

    fireEvent.change(title, { target: { value: "Party RSVP" } });
    await waitFor(() => expect(reg.save).toBeTruthy());
    await act(async () => {
      await reg.save?.();
    });
    expect(
      calls.some(([u, m]) => u.includes("/api/v1/drives/d1/files/upload") && m === "POST"),
    ).toBe(true);
  });

  it("view-only members see questions and answers but never a save", async () => {
    const calls = stubFetch((u) => {
      if (u.includes("/files/content")) return new Response(FORM_DOC, { status: 200 });
      if (u.includes("/api/v1/forms/responses")) {
        return json({ responses: [{ id: "r1", answers: { q_1: "Ann" } }] });
      }
      return json({}, 404);
    });
    const reg = mountBuilder({ canWrite: false });

    const title = await screen.findByLabelText("Form title");
    expect(title).toBeDisabled();
    // The save thunk is never registered for a viewer.
    await act(async () => {});
    expect(reg.save).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Responses/ }));
    expect((await screen.findAllByText("Ann")).length).toBeGreaterThan(0);
    expect(calls.some(([u]) => u.includes("/files/upload"))).toBe(false);
  });
});

describe("FormBuilder guest source", () => {
  const guest = (caps) =>
    /** @type {import("../../../lib/fileSource.jsx").FileSource} */ (
      shareSource({ token: "tok", kind: "file", fileName: "rsvp.lunaform", caps })
    );

  function guestFetch() {
    return stubFetch((u, m) => {
      if (u === "/s/tok/file") return new Response(FORM_DOC, { status: 200 });
      if (u.startsWith("/s/tok/responses")) {
        return json({ responses: [{ id: "r1", answers: { q_1: "Bob" } }] });
      }
      if (u === "/s/tok/upload" && m === "POST") return json({ upload_id: "u9" });
      if (u.includes("/s/tok/upload/u9/complete")) return json({ ok: true });
      return json({}, 404);
    });
  }

  it("a full link guest edits the same fields and saves through /s/", async () => {
    const calls = guestFetch();
    const reg = mountBuilder({ source: guest("full"), canWrite: true });

    const title = await screen.findByLabelText("Form title");
    expect(title).toHaveValue("Family reunion RSVP");
    // Guests read the link-scoped responses route — never the member API.
    expect(calls.some(([u]) => u === "/s/tok/responses")).toBe(true);
    // Guests can fill the form in but cannot manage sharing.
    expect(screen.queryByRole("button", { name: "Share this form" })).not.toBeInTheDocument();

    fireEvent.change(title, { target: { value: "Party" } });
    await waitFor(() => expect(reg.save).toBeTruthy());
    await act(async () => {
      await reg.save?.();
    });
    expect(calls.some(([u, m]) => u === "/s/tok/upload" && m === "POST")).toBe(true);
    expect(calls.some(([u]) => u.includes("/api/v1/"))).toBe(false);
  });

  it("a view link guest reads everything but cannot save", async () => {
    const calls = guestFetch();
    const reg = mountBuilder({ source: guest("view"), canWrite: false });

    const title = await screen.findByLabelText("Form title");
    expect(title).toBeDisabled();
    await act(async () => {});
    expect(reg.save).toBeNull();
    expect(calls.some(([u]) => u.includes("/s/tok/upload"))).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: /Responses/ }));
    expect((await screen.findAllByText("Bob")).length).toBeGreaterThan(0);
  });
});
