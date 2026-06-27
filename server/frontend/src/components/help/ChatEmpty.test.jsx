import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ChatEmpty from "./ChatEmpty";

describe("ChatEmpty", () => {
  it("renders the ready prompt", () => {
    render(<ChatEmpty />);
    expect(screen.getByText(/at the ready/i)).toBeTruthy();
  });
});