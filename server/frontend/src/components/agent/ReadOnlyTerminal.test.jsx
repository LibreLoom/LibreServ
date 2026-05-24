import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ReadOnlyTerminal from "./ReadOnlyTerminal.jsx";

describe("ReadOnlyTerminal", () => {
  it("renders content", () => {
    render(<ReadOnlyTerminal content="hello world" />);
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("shows default title", () => {
    render(<ReadOnlyTerminal content="test" />);
    expect(screen.getByText("Output")).toBeInTheDocument();
  });

  it("shows custom title", () => {
    render(<ReadOnlyTerminal content="test" title="Logs" />);
    expect(screen.getByText("Logs")).toBeInTheDocument();
  });

  it("shows placeholder when no content", () => {
    render(<ReadOnlyTerminal content="" />);
    expect(screen.getByText("No output yet.")).toBeInTheDocument();
  });

  it("shows copy button", () => {
    render(<ReadOnlyTerminal content="test" />);
    expect(screen.getByText("Copy")).toBeInTheDocument();
  });
});
