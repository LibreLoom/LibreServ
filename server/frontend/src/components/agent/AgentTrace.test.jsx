/* color-scan: ignore-file - test fixtures with intentional avatar colors */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentTrace, { AgentDot } from "./AgentTrace.jsx";

function makeEvent(type, overrides = {}) {
  return { type, ...overrides };
}

describe("AgentDot", () => {
  it("renders with diamond shape", () => {
    const { container } = render(<AgentDot shape="diamond" color="#FF6B35" />);
    const svg = /** @type {SVGSVGElement} */ (container.firstChild);
    expect(svg).toBeTruthy();
    const rect = svg.querySelector("rect");
    expect(rect).toBeTruthy();
    expect(rect.getAttribute("fill")).toBe("#FF6B35");
  });

  it("renders with circle shape", () => {
    const { container } = render(<AgentDot shape="circle" color="#4ECDC4" />);
    const svg = /** @type {SVGSVGElement} */ (container.firstChild);
    expect(svg).toBeTruthy();
    expect(svg.classList.contains("inline-block")).toBe(true);
    const circle = svg.querySelector("circle");
    expect(circle).toBeTruthy();
    expect(circle.getAttribute("fill")).toBe("#4ECDC4");
  });

  it("renders with custom size", () => {
    const { container } = render(<AgentDot shape="circle" color="#4ECDC4" size={32} />);
    const svg = /** @type {SVGSVGElement} */ (container.firstChild);
    expect(svg.getAttribute("width")).toBe("32");
    expect(svg.getAttribute("height")).toBe("32");
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

    const btn = screen.getByRole("button", { name: /agents?\s+deliberating/ });
    await user.click(btn);

    expect(screen.getByText("Checking logs...")).toBeTruthy();
  });

  it("shows consensus results", async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent("agent_thinking", { agent_id: "agent-1", avatar_shape: "diamond", avatar_color: "#FF6B35", turn: 1 }),
      makeEvent("proposal", { id: "prop-1", agent_id: "agent-1", proposal_type: "write", tool_calls: [{ id: "tc-1", name: "docker_restart", arguments: "{}", agent_id: "agent-1" }], turn: 1 }),
      makeEvent("consensus", { proposal_id: "prop-1", result: "approved", votes: [{ agent_id: "agent-1", decision: "approve" }] }),
    ];
    render(<AgentTrace events={events} />);

    const btn = screen.getByRole("button", { name: /agents?\s+deliberating/ });
    await user.click(btn);

    expect(screen.getByText("approved")).toBeTruthy();
  });

  it("shows rejected consensus", async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent("agent_thinking", { agent_id: "agent-1", avatar_shape: "diamond", avatar_color: "#FF6B35", turn: 1 }),
      makeEvent("proposal", { id: "prop-1", agent_id: "agent-1", proposal_type: "final_response", turn: 1 }),
      makeEvent("consensus", { proposal_id: "prop-1", result: "rejected", votes: [{ agent_id: "agent-1", decision: "reject" }] }),
    ];
    render(<AgentTrace events={events} />);

    const btn = screen.getByRole("button", { name: /agents?\s+deliberating/ });
    await user.click(btn);

    expect(screen.getByText("rejected")).toBeTruthy();
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
      makeEvent("agent_thinking", { agent_id: "agent-1", avatar_shape: "diamond", avatar_color: "#FF6B35", turn: 1 }),
      makeEvent("tool_call", { id: "tc-1", name: "docker_logs", agent_id: "agent-1", turn: 1 }),
      makeEvent("tool_result", { id: "tc-1", content: "connection refused", is_error: false }),
    ];
    render(<AgentTrace events={events} />);

    const mainBtn = screen.getByRole("button", { name: /agents?\s+deliberating/ });
    await user.click(mainBtn);

    const turnBtn = screen.getByRole("button", { name: /Turn 1/ });
    await user.click(turnBtn);

    expect(screen.getByText("Docker logs")).toBeTruthy();
  });

  it("shows agent vote badges", async () => {
    const user = userEvent.setup();
    const events = [
      makeEvent("agent_thinking", { agent_id: "agent-1", avatar_shape: "diamond", avatar_color: "#FF6B35", turn: 1 }),
      makeEvent("agent_thinking", { agent_id: "agent-2", avatar_shape: "circle", avatar_color: "#4ECDC4", turn: 1 }),
      makeEvent("proposal", { id: "prop-1", agent_id: "agent-1", proposal_type: "final_response", turn: 1 }),
      makeEvent("vote", { proposal_id: "prop-1", agent_id: "agent-2", decision: "approve", reason: "safe", avatar_shape: "circle", avatar_color: "#4ECDC4" }),
    ];
    render(<AgentTrace events={events} />);

    const mainBtn = screen.getByRole("button", { name: /agents?\s+deliberating/ });
    await user.click(mainBtn);

    const turnBtn = screen.getByRole("button", { name: /Turn 1/ });
    await user.click(turnBtn);

    const propBtn = screen.getByRole("button", { name: /Final response/ });
    await user.click(propBtn);

    expect(screen.getByText("safe")).toBeTruthy();
  });
});
