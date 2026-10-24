// Render tests for the gallery's own parts (written, not run: the orchestrator runs ./ci).
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ResultBox, FaultPanel } from "./Gallery.jsx";
import Gallery from "./Gallery.jsx";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { ShortcutsProvider } from "@libreloom/ui/context/ShortcutsContext.jsx";

const snapshot = (over = {}) => ({
  version: 1,
  offline: false,
  latency: 0,
  faults: [],
  log: [],
  unhandled: [],
  crashed: [],
  sessionUserId: "u1",
  users: [{ id: "u1", display_name: "Max", role: "admin" }],
  ...over,
});

const fakeControl = () => ({
  setOffline: vi.fn(), setLatency: vi.fn(), expireSession: vi.fn(), addFault: vi.fn(), removeFault: vi.fn(),
  setFaultOn: vi.fn(), signInAs: vi.fn(), addMember: vi.fn(() => "u9"), saveNow: vi.fn(),
});

describe("ResultBox", () => {
  it("keeps the note itself, passes it on only when a result is recorded, and writes the draft to the ref", () => {
    const draftsRef = { current: {} };
    const onRecord = vi.fn();
    render(<ResultBox scenarioId="a/b" initialNote="" draftsRef={draftsRef} advance onAdvance={() => {}} onRecord={onRecord} />);
    const problem = screen.getByRole("button", { name: "Problem" });
    expect(problem).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("What went wrong? (saved with the result)"), { target: { value: "Upload stalls" } });
    expect(draftsRef.current["a/b"]).toBe("Upload stalls");
    expect(onRecord).not.toHaveBeenCalled();
    expect(problem).toBeEnabled();
    fireEvent.click(problem);
    expect(onRecord).toHaveBeenCalledWith("fail", "Upload stalls");
  });

  it("starts from the saved note", () => {
    render(<ResultBox scenarioId="a/b" initialNote="Seen before" draftsRef={{ current: {} }} advance={false} onAdvance={() => {}} onRecord={() => {}} />);
    expect(screen.getByDisplayValue("Seen before")).toBeInTheDocument();
  });
});

describe("FaultPanel", () => {
  it("shows how many requests each rule caught, and lets a rule be switched off", () => {
    const c = fakeControl();
    const snap = snapshot({ faults: [{ id: "f1", match: "GET /api/v1/drives", mode: "500", on: true, hits: 3 }] });
    render(<FaultPanel snap={snap} getControl={() => c} onSignedIn={() => {}} />);
    expect(screen.getByText(/GET \/api\/v1\/drives → 500 · caught 3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Rule GET /api/v1/drives is on" }));
    expect(c.setFaultOn).toHaveBeenCalledWith("f1", false);
  });

  it("says when the fake itself crashed", () => {
    const snap = snapshot({ crashed: [{ key: "GET /api/v1/x", message: "boom", count: 2 }] });
    render(<FaultPanel snap={snap} getControl={fakeControl} onSignedIn={() => {}} />);
    expect(screen.getByText(/fake crashed: boom/)).toBeInTheDocument();
  });

  it("switches who the app is signed in as, and reloads the app", () => {
    const c = fakeControl();
    const onSignedIn = vi.fn();
    const snap = snapshot({ users: [{ id: "u1", display_name: "Max", role: "admin" }, { id: "u2", display_name: "Sam", role: "user" }] });
    render(<FaultPanel snap={snap} getControl={() => c} onSignedIn={onSignedIn} />);
    fireEvent.change(screen.getByLabelText("Sign in as"), { target: { value: "u2" } });
    expect(c.signInAs).toHaveBeenCalledWith("u2");
    expect(c.saveNow).toHaveBeenCalled();
    expect(onSignedIn).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Sign in as"), { target: { value: "__signed_out__" } });
    expect(c.signInAs).toHaveBeenLastCalledWith(null);
  });

  it("offers a new Member when there is none, and shows a request's answer on click", () => {
    const c = fakeControl();
    const snap = snapshot({ log: [{ t: 1, method: "GET", path: "/api/v1/drives", status: 200, note: "", body: '[{"id":"d1"}]' }] });
    render(<FaultPanel snap={snap} getControl={() => c} onSignedIn={() => {}} />);
    fireEvent.change(screen.getByLabelText("Sign in as"), { target: { value: "__new_member__" } });
    expect(c.addMember).toHaveBeenCalled();
    expect(c.signInAs).toHaveBeenCalledWith("u9");
    fireEvent.click(screen.getByText(/200 GET \/api\/v1\/drives/));
    expect(screen.getByText('[{"id":"d1"}]')).toBeInTheDocument();
  });
});

describe("Gallery", () => {
  it("lists the scenarios and shows the checklist of the selected one", () => {
    window.location.hash = "#files%2Foverview";
    render(
      <ToastProvider>
        <ShortcutsProvider>
          <Gallery />
        </ShortcutsProvider>
      </ToastProvider>,
    );
    expect(screen.getByRole("navigation", { name: "Scenarios" })).toBeInTheDocument();
    expect(screen.getAllByText("Normal drive, a few folders").length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText("What went wrong? (saved with the result)")).toBeInTheDocument();
  });
});
