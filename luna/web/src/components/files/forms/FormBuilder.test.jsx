import { describe, expect, it, vi, afterEach } from "vitest";

const socketState = vi.hoisted(() => ({ instances: [] }));

// Drive editing opens the collab hub. This stand-in welcomes a single peer
// so the form seeds from the file without a real WebSocket.
vi.mock("../office/collabSocket.js", () => ({
  CollabSocket: class {
    constructor() {
      this.onMessage = null;
      this.onStatus = null;
      this._closed = false;
      this._attempts = 0;
      socketState.instances.push(this);
    }
    connect() {
      this.onStatus?.("open");
      this.onMessage?.({
        type: "welcome",
        peer_id: 1,
        peers: [{ peer_id: 1, username: "Max", color: "var(--accent)" }],
      });
    }
    close() { this._closed = true; }
    sendOp() {}
    sendPresence() {}
    sendSaved() {}
  },
}));
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import FormBuilder from "./FormBuilder.jsx";
import { driveSource, FileSourceProvider, shareSource } from "../../../lib/fileSource.jsx";

vi.mock("../../share/ShareSheet.jsx", () => ({
  default: ({ startWithNewLink }) => (
    <div role="dialog" aria-label={startWithNewLink ? "New link" : "Share"} />
  ),
}));

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
      <ToastProvider>
        <Toaster />
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
      </ToastProvider>
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
  socketState.instances.length = 0;
});

describe("FormBuilder drive source", () => {
  it("loads through the member APIs and saves through the upload route", async () => {
    const calls = stubFetch((u, m) => {
      if (u.includes("/files/content")) return new Response(FORM_DOC, { status: 200 });
      if (u.includes("/api/v1/forms/summary")) {
        return json({
          total: 1,
          questions: [{ id: "q_1", answered: 1, values: [] }],
        });
      }
      if (u.includes("/api/v1/forms/responses")) {
        return json({ responses: [{ id: "r1", answers: { q_1: "Ann" } }], total: 1, next_offset: null });
      }
      if (u.includes("/files/upload") && m === "POST") return json({ name: "rsvp.lunaform" });
      return json({}, 404);
    });
    const reg = mountBuilder();

    const title = await screen.findByLabelText("Form title");
    expect(title).toHaveValue("Family reunion RSVP");
    // The Questions tab never pulls the answers file.
    expect(calls.some(([u]) => u.includes("/api/v1/forms/responses"))).toBe(false);
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

    fireEvent.click(screen.getByRole("radio", { name: /Responses/ }));
    expect((await screen.findAllByText("Ann")).length).toBeGreaterThan(0);
    // Only the first page is requested.
    expect(
      calls.some(([u]) => u.includes("/api/v1/forms/responses?drive_id=d1&path=rsvp.lunaform&offset=0&limit=100")),
    ).toBe(true);
  });

  it("view-only members see questions and answers but never a save", async () => {
    const calls = stubFetch((u) => {
      if (u.includes("/files/content")) return new Response(FORM_DOC, { status: 200 });
      if (u.includes("/api/v1/forms/summary")) {
        return json({ total: 1, questions: [{ id: "q_1", answered: 1, values: [] }] });
      }
      if (u.includes("/api/v1/forms/responses")) {
        return json({ responses: [{ id: "r1", answers: { q_1: "Ann" } }], total: 1, next_offset: null });
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

describe("FormBuilder attachments", () => {
  const FILE_DOC = JSON.stringify({
    version: 1,
    title: "Receipts",
    settings: { collecting: true },
    questions: [{ v: 1, id: "q_f", type: "file", label: "Receipt", config: {} }],
  });

  it("links attachments through the form's own file route, never the drive files API", async () => {
    stubFetch((u) => {
      if (u.includes("/files/content")) return new Response(FILE_DOC, { status: 200 });
      if (u.includes("/api/v1/forms/summary")) {
        return json({ total: 1, questions: [{ id: "q_f", answered: 1, values: [] }] });
      }
      if (u.includes("/api/v1/forms/responses")) {
        return json({
          responses: [{ id: "r1", answers: { q_f: "0123456789abcdef.pdf" } }],
          total: 1,
          next_offset: null,
        });
      }
      return json({}, 404);
    });
    mountBuilder();
    fireEvent.click(await screen.findByRole("radio", { name: /Responses/ }));
    // The summary stays a count; the attachment opens from its response.
    fireEvent.click(await screen.findByText("0123456789abcdef.pdf"));
    const link = await screen.findByRole("link", { name: "Open the attached file" });
    expect(link.getAttribute("href")).toBe(
      "/api/v1/forms/file?drive_id=d1&path=rsvp.lunaform&name=0123456789abcdef.pdf",
    );
  });

  it("builds the guest route from the link, with no path for a file link", () => {
    const source = shareSource({ token: "tok", kind: "file", fileName: "rsvp.lunaform", caps: "full" });
    expect(source.formFileHref("d1", "", "0123456789abcdef.pdf")).toBe(
      "/s/tok/form-file?name=0123456789abcdef.pdf",
    );
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
      if (u.startsWith("/s/tok/summary")) {
        return json({ total: 1, questions: [{ id: "q_1", answered: 1, values: [] }] });
      }
      if (u.startsWith("/s/tok/responses")) {
        return json({ responses: [{ id: "r1", answers: { q_1: "Bob" } }], total: 1, next_offset: null });
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
    // Guests do not pull answers until the Responses tab opens.
    expect(calls.some(([u]) => u.startsWith("/s/tok/responses"))).toBe(false);
    // Guests can fill the form in but cannot manage sharing.
    expect(screen.queryByRole("button", { name: "Share this form" })).not.toBeInTheDocument();

    fireEvent.change(title, { target: { value: "Party" } });
    await waitFor(() => expect(reg.save).toBeTruthy());
    await act(async () => {
      await reg.save?.();
    });
    expect(calls.some(([u, m]) => u === "/s/tok/upload" && m === "POST")).toBe(true);
    expect(calls.some(([u]) => u.includes("/api/v1/"))).toBe(false);

    // Guests read the link-scoped routes — never the member API.
    fireEvent.click(screen.getByRole("radio", { name: /Responses/ }));
    expect((await screen.findAllByText("Bob")).length).toBeGreaterThan(0);
    expect(calls.some(([u]) => u.startsWith("/s/tok/responses"))).toBe(true);
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

describe("FormBuilder responses paging", () => {
  const MANY = JSON.stringify({
    version: 1,
    title: "Potluck",
    settings: {},
    questions: [
      { v: 1, id: "q_c", type: "choice", label: "Coming?", config: { options: ["Yes", "No"] } },
      { v: 1, id: "q_t", type: "short_text", label: "Name", config: {} },
    ],
  });

  function stubPages() {
    return stubFetch((u) => {
      if (u.includes("/files/content")) return new Response(MANY, { status: 200 });
      if (u.includes("/api/v1/forms/summary")) {
        return json({
          total: 250,
          questions: [
            {
              id: "q_c",
              answered: 250,
              values: [{ value: "Yes", count: 200 }, { value: "No", count: 50 }],
            },
            { id: "q_t", answered: 240, values: [] },
          ],
        });
      }
      if (u.includes("/api/v1/forms/responses")) {
        const offset = Number(new URL(u, "http://luna").searchParams.get("offset")) || 0;
        if (offset === 0) {
          return json({
            responses: [{ id: "r1", answers: { q_c: "Yes", q_t: "first" } }],
            total: 250,
            next_offset: 100,
          });
        }
        return json({
          responses: [{ id: "r101", answers: { q_c: "No", q_t: "second" } }],
          total: 250,
          next_offset: 200,
        });
      }
      return json({}, 404);
    });
  }

  it("shows one page and the summary for the whole answers file", async () => {
    const calls = stubPages();
    mountBuilder();
    await screen.findByLabelText("Form title");
    fireEvent.click(screen.getByRole("radio", { name: /Responses/ }));

    expect(await screen.findByText("first")).toBeInTheDocument();
    expect(screen.getByText("Showing 1–1 of 250")).toBeInTheDocument();
    // Summary answers cover every page, not just the row on screen.
    expect(screen.getAllByText("250 answered").length).toBeGreaterThan(0);
    expect(screen.getByText("200 · 80%")).toBeInTheDocument();
    expect(screen.getByText(/Answers are in the table below/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Next page/ }));
    expect(await screen.findByText("second")).toBeInTheDocument();
    expect(screen.getByText("Showing 101–101 of 250")).toBeInTheDocument();
    expect(
      calls.some(([u]) => u.includes("offset=100&limit=100")),
    ).toBe(true);
  });

  it("refreshes the page and summary only while Responses is open", async () => {
    const calls = stubPages();
    mountBuilder();
    await screen.findByLabelText("Form title");
    const socket = socketState.instances[socketState.instances.length - 1];
    expect(socket).toBeTruthy();

    // Questions tab: the event is ignored.
    await act(async () => {
      socket.onMessage({ type: "form_response", count: 1 });
    });
    expect(calls.some(([u]) => u.includes("/api/v1/forms/responses"))).toBe(false);

    fireEvent.click(screen.getByRole("radio", { name: /Responses/ }));
    await screen.findByText("first");
    await screen.findByText("250 answered");
    const before = calls.filter(([u]) => u.includes("/api/v1/forms/responses")).length;
    const summaries = calls.filter(([u]) => u.includes("/api/v1/forms/summary")).length;

    await act(async () => {
      socket.onMessage({ type: "form_response", count: 2 });
    });
    await waitFor(() =>
      expect(
        calls.filter(([u]) => u.includes("/api/v1/forms/responses")).length,
      ).toBe(before + 1),
    );
    expect(calls.filter(([u]) => u.includes("/api/v1/forms/summary")).length).toBe(summaries + 1);
  });
});

describe("FormBuilder editing", () => {
  const TWO = JSON.stringify({
    version: 1,
    title: "Potluck",
    settings: {},
    questions: [
      { v: 1, id: "q_a", type: "choice", label: "Dish?", config: { options: ["Salad", "Soup"] } },
      { v: 1, id: "q_b", type: "long_text", label: "Anything else?", config: {} },
    ],
  });

  function stubForm() {
    return stubFetch((u) => {
      if (u.includes("/files/content")) return new Response(TWO, { status: 200 });
      if (u.includes("/api/v1/forms/summary")) return json({ total: 0, questions: [] });
      if (u.includes("/api/v1/forms/responses")) return json({ responses: [], total: 0, next_offset: null });
      return json({}, 404);
    });
  }

  it("edits a picture's description in place and clears it with the picture", async () => {
    const withPicture = JSON.stringify({
      version: 1,
      title: "Potluck",
      settings: {},
      questions: [
        { v: 1, id: "q_a", type: "short_text", label: "Dish?", image: "ab12.png", imageAlt: "A salad bowl", config: {} },
        { v: 1, id: "q_b", type: "short_text", label: "Drink?", config: {} },
      ],
    });
    stubFetch((u) => {
      if (u.includes("/files/content") && !u.includes("ab12")) {
        return new Response(withPicture, { status: 200 });
      }
      if (u.includes("/api/v1/forms/responses")) return json({ responses: [] });
      return json({}, 404);
    });
    mountBuilder();
    const alt = await screen.findByLabelText("Picture description for question 1");
    expect(alt).toHaveValue("A salad bowl");
    // Only questions with a picture get the field.
    expect(screen.queryByLabelText("Picture description for question 2")).toBeNull();
    fireEvent.change(alt, { target: { value: "A big salad" } });
    expect(await screen.findByDisplayValue("A big salad")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove picture" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Picture description for question 1")).toBeNull(),
    );
  });

  it("moves a question down and keeps everything on it", async () => {
    stubForm();
    mountBuilder();
    await screen.findByDisplayValue("Dish?");
    fireEvent.click(screen.getAllByRole("button", { name: "Move this question down" })[0]);
    await waitFor(() => {
      const labels = screen.getAllByLabelText(/^Question \d$/).map((el) => /** @type {HTMLInputElement} */ (el).value);
      expect(labels).toEqual(["Anything else?", "Dish?"]);
    });
    expect(screen.getByDisplayValue("Salad")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Soup")).toBeInTheDocument();
  });

  it("adds a question from the shared menu, and has no notify setting", async () => {
    stubForm();
    mountBuilder();
    await screen.findByDisplayValue("Dish?");
    expect(screen.queryByText(/Tell me when someone answers/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add a question/i }));
    fireEvent.click(await screen.findByRole("option", { name: /Email/ }));
    await waitFor(() => expect(screen.getAllByLabelText(/^Question \d$/)).toHaveLength(3));
  });

  it("Collect responses goes straight to the New link form", async () => {
    stubForm();
    mountBuilder();
    await screen.findByDisplayValue("Dish?");
    fireEvent.click(screen.getByRole("button", { name: /Collect responses/i }));
    expect(await screen.findByRole("dialog", { name: "New link" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Share" })).toBeNull();
  });

  it("removes a question and brings it back with Undo", async () => {
    stubForm();
    mountBuilder();
    await screen.findByDisplayValue("Dish?");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove this question" })[1]);
    await waitFor(() => expect(screen.queryByDisplayValue("Anything else?")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByDisplayValue("Anything else?")).toBeInTheDocument();
  });

  it("keeps options when a choice question becomes checkboxes", async () => {
    stubForm();
    mountBuilder();
    await screen.findByDisplayValue("Dish?");
    fireEvent.click(screen.getAllByRole("button", { name: "Question type" })[0]);
    fireEvent.click(await screen.findByRole("option", { name: /Checkboxes/ }));
    await waitFor(() => expect(screen.getByDisplayValue("Salad")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Soup")).toBeInTheDocument();
  });
});

