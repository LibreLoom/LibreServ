import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ChatMessage from "./ChatMessage";

describe("ChatMessage", () => {
  it("renders the message content", () => {
    render(<ChatMessage role="assistant" content="Hello there" />);
    expect(screen.getByText("Hello there")).toBeTruthy();
  });

  it("aligns assistant messages to the start (left)", () => {
    const { container } = render(<ChatMessage role="assistant" content="hi" />);
    expect(container.querySelector(".justify-start")).toBeTruthy();
    expect(container.querySelector(".justify-end")).toBeNull();
  });

  it("aligns user messages to the end (right)", () => {
    const { container } = render(<ChatMessage role="user" content="hi" />);
    expect(container.querySelector(".justify-end")).toBeTruthy();
    expect(container.querySelector(".justify-start")).toBeNull();
  });
});