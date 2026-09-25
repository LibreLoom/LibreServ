import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  render,
  screen,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DiagramEditor from "./DiagramEditor.jsx";

// HACK coverage: advisory .drawio edit lock UX — the blocked card, the
// read-only path out of it, and the lock-lost save-a-copy modal.

vi.mock("@libreloom/ui/hooks/useTheme.jsx", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

const PROPS = {
  driveId: "d",
  path: "docs/plan.drawio",
  canWrite: true,
  onClose: () => {},
};

class MockWebSocket {
  /** @type {MockWebSocket[]} */
  static instances = [];

  /** @param {string} url */
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  send() {}

  emit(type, event) {
    for (const fn of this.listeners[type] || []) fn(event);
  }

  serverSays(msg) {
    this.emit("message", { data: JSON.stringify(msg) });
  }

  drop() {
    this.emit("close", {});
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }
}

function lastSocket() {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

/** Route the component's fetches: pack probe, file content, lock release. */
function stubLuna() {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/drawio/pack.json")) {
        return jsonResponse(200, { pack: "luna-drawio", version: "v1" });
      }
      if (u.includes("/files/content")) {
        return textResponse("<mxfile/>");
      }
      return jsonResponse(200, {});
    }),
  );
}

afterEach(() => {
  MockWebSocket.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DiagramEditor lock UX", () => {
  it("shows the who-is-editing card when the lock is held by someone else", async () => {
    stubLuna();
    vi.stubGlobal("WebSocket", MockWebSocket);
    render(<DiagramEditor {...PROPS} />);
    await act(async () => {});
    await act(async () => {
      lastSocket().serverSays({ type: "locked", holder: "Sam" });
    });

    expect(
      await screen.findByText("Sam is editing this diagram"),
    ).toBeTruthy();
    expect(screen.getByText("Open read-only")).toBeTruthy();
    expect(screen.getByText("Download")).toBeTruthy();
    expect(screen.getByText("Close")).toBeTruthy();
    // The editor iframe must never mount while blocked.
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("a same-user block says it's your own session elsewhere", async () => {
    stubLuna();
    vi.stubGlobal("WebSocket", MockWebSocket);
    render(<DiagramEditor {...PROPS} />);
    await act(async () => {});
    await act(async () => {
      lastSocket().serverSays({ type: "locked", holder: "Sam", self: true });
    });

    expect(
      await screen.findByText("You're already editing this diagram"),
    ).toBeTruthy();
    expect(screen.getByText(/another tab or on another device/)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("Open read-only mounts the editor without locking again", async () => {
    stubLuna();
    vi.stubGlobal("WebSocket", MockWebSocket);
    render(<DiagramEditor {...PROPS} />);
    await act(async () => {});
    await act(async () => {
      lastSocket().serverSays({ type: "locked", holder: "Sam" });
    });
    await screen.findByText("Sam is editing this diagram");

    await userEvent.click(screen.getByText("Open read-only"));

    const iframe = await screen.findByTitle(/Diagram editor/);
    expect(iframe.getAttribute("src")).toContain("noSaveBtn=1");
    // Exactly one acquire attempt — the read-only mount must not re-lock.
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("view-only opens never touch the lock", async () => {
    stubLuna();
    vi.stubGlobal("WebSocket", MockWebSocket);
    render(<DiagramEditor {...PROPS} canWrite={false} />);

    const iframe = await screen.findByTitle(/Diagram editor/);
    expect(iframe.getAttribute("src")).toContain("noSaveBtn=1");
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("editable opens take the lock socket and mount the writable embed", async () => {
    stubLuna();
    vi.stubGlobal("WebSocket", MockWebSocket);
    render(<DiagramEditor {...PROPS} />);
    await act(async () => {});
    await act(async () => {
      lastSocket().serverSays({ type: "held" });
    });

    const iframe = await screen.findByTitle(/Diagram editor/);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(iframe.getAttribute("src")).not.toContain("noSaveBtn");
  });

  it("a lost hold interrupts once with a modal — not a banner", async () => {
    stubLuna();
    vi.stubGlobal("WebSocket", MockWebSocket);
    render(<DiagramEditor {...PROPS} />);
    await act(async () => {});
    await act(async () => {
      lastSocket().serverSays({ type: "held" });
    });
    await screen.findByTitle(/Diagram editor/);

    await act(async () => {
      lastSocket().serverSays({ type: "lost", holder: "Sam" });
    });

    expect(await screen.findByText("Editing session ended")).toBeTruthy();
    expect(
      screen.getByText(/Sam is editing this diagram now/),
    ).toBeTruthy();
    expect(screen.getByText("Download my changes")).toBeTruthy();
    // The modal is a real dialog portaled above the editor overlay, not
    // inline banner text in the layout.
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.querySelector(".z-\\[90\\]")).toBeTruthy();
  });

  it("the lost modal dismisses once and stays dismissed", async () => {
    stubLuna();
    vi.stubGlobal("WebSocket", MockWebSocket);
    render(<DiagramEditor {...PROPS} />);
    await act(async () => {});
    await act(async () => {
      lastSocket().serverSays({ type: "held" });
    });
    await screen.findByTitle(/Diagram editor/);
    await act(async () => {
      lastSocket().serverSays({ type: "lost", holder: "Sam" });
    });
    await screen.findByText("Editing session ended");

    await userEvent.click(
      screen.getByText("Keep editing — saves become downloads"),
    );

    // Status is still "lost" — the modal must not re-spawn after its
    // exit animation finishes.
    await waitForElementToBeRemoved(() =>
      screen.queryByText("Editing session ended"),
    );
  });
});
