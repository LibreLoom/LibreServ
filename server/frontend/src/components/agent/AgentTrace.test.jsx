import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentTrace, { AgentAvatar } from "./AgentTrace.jsx";

function makeEvent(type, overrides = {}) {
  return { type, ...overrides };
}

describe("AgentAvatar", () => {
  it("renders with diamond shape", () => {
    const { container } = render(<AgentAvatar shape="diamond" color="#FF6B35" />);
    const el = container.firstChild;
    expect(el).toBeTruthy();
    expect(el.style.backgroundColor).toBe("rgb(255, 107, 53)");
  });

  it("renders with circle shape", () => {
    const { container } = render(<AgentAvatar shape="circle" color="#4ECDC4" />);
    const el = container.firstChild;
    expect(el).toBeTruthy();
    expect(el.className).toContain("rounded-full");
  });

  it("renders with custom size", () => {
    const { container } = render(<AgentAvatar shape="circle" color="#4ECDC4" size={32} />);
    const el = container.firstChild;
    expect(el.style.width).toBe("32px");
    expect(el.style.height).toBe("32px");
  });
});

describe("AgentTrace", () => {
  it("returns null when no deliberation events", () => {
    const { container } = render(<AgentTrace events={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders agent count when agents are thinking", () => {
    const events = [
      makeEvent("agent_thinking", { agent_id: "agent-1", avatar_shape: "diamond", avatar_color: "#FF6B35", model: "mimo" }),
      makeEvent("agent_thinking", { agent_id: "agent-2", avatar_shape: "circle", avatar_color: "#4ECDC4", model: "kimi" }),
    ];
    render(<AgentTrace events={events} />);
    expect(screen.getByText(/2 agents deliberating/)).toBeTruthy();
  });

  it("expands to show agent blocks", async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent("agent_thinking", { agent_id: "agent-1", avatar_shape: "diamond", avatar_color: "#FF6B35", model: "mimo" }),
      makeEvent("agent_message", { agent_id: "agent-1", content: "Checking logs..." }),
      makeEvent("agent_thinking", { agent_id: "agent-2", avatar_shape: "circle", avatar_color: "#4ECDC4", model: "kimi" }),
    ];
    render(<AgentTrace events={events} />);

    const btn = screen.getByRole("button", { expanded: false });
    await user.click(btn);

    expect(screen.getByText("Checking logs...")).toBeTruthy();
  });

  it("shows consensus results", async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent("agent_thinking", { agent_id: "agent-1", avatar_shape: "diamond", avatar_color: "#FF6B35" }),
      makeEvent("consensus", { result: "approved", votes: [{ agent_id: "agent-2", decision: "approve" }] }),
    ];
    render(<AgentTrace events={events} />);

    const btn = screen.getByRole("button", { expanded: false });
    await user.click(btn);

    expect(screen.getByText("Approved")).toBeTruthy();
  });

  it("shows rejected consensus", async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent("agent_thinking", { agent_id: "agent-1", avatar_shape: "diamond", avatar_color: "#FF6B35" }),
      makeEvent("consensus", { result: "rejected", votes: [{ agent_id: "agent-2", decision: "reject" }] }),
    ];
    render(<AgentTrace events={events} />);

    const btn = screen.getByRole("button", { expanded: false });
    await user.click(btn);

    expect(screen.getByText("Rejected")).toBeTruthy();
  });

  it("shows snapshot count", () => {
    const events = [
      makeEvent("agent_thinking", { agent_id: "agent-1", avatar_shape: "diamond", avatar_color: "#FF6B35" }),
      makeEvent("snapshot_created", { tool_call_id: "tc-1" }),
    ];
    render(<AgentTrace events={events} />);
    expect(screen.getByText(/1 backup/)).toBeTruthy();
  });

  it("shows tool calls per agent", async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent("agent_thinking", { agent_id: "agent-1", avatar_shape: "diamond", avatar_color: "#FF6B35" }),
      makeEvent("tool_call", { id: "tc-1", name: "docker_logs", agent_id: "agent-1" }),
      makeEvent("tool_result", { id: "tc-1", content: "connection refused", is_error: false }),
    ];
    render(<AgentTrace events={events} />);

    const btn = screen.getByRole("button", { expanded: false });
    await user.click(btn);

    expect(screen.getByText(/1 action/)).toBeTruthy();
  });

  it("shows agent vote badges", async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent("agent_thinking", { agent_id: "agent-1", avatar_shape: "diamond", avatar_color: "#FF6B35" }),
      makeEvent("agent_thinking", { agent_id: "agent-2", avatar_shape: "circle", avatar_color: "#4ECDC4" }),
      makeEvent("vote", { agent_id: "agent-2", decision: "approve", reason: "safe" }),
    ];
    render(<AgentTrace events={events} />);

    const btn = screen.getByRole("button", { expanded: false });
    await user.click(btn);

    expect(screen.getByText("safe")).toBeTruthy();
  });
});
