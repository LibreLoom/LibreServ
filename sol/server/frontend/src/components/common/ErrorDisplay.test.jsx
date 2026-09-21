import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ErrorDisplay,
  InlineError,
  FormErrorSummary,
  ApiError,
} from "./ErrorDisplay";

describe("ErrorDisplay", () => {
  it("renders error message with correct role", () => {
    render(<ErrorDisplay message="Something broke" />);
    expect(screen.getByText("Something broke")).toBeInTheDocument();
  });

  it("renders error type with AlertCircle icon", () => {
    const { container } = render(
      <ErrorDisplay message="fail" type="error" />,
    );
    expect(container.querySelector(".text-error")).toBeInTheDocument();
  });

  it("renders warning type with AlertTriangle icon", () => {
    const { container } = render(
      <ErrorDisplay message="careful" type="warning" />,
    );
    expect(container.querySelector(".text-warning")).toBeInTheDocument();
  });

  it("renders info type with Info icon", () => {
    const { container } = render(
      <ErrorDisplay message="fyi" type="info" />,
    );
    expect(container.querySelector(".text-info")).toBeInTheDocument();
  });

  it("shows dismiss button when dismissible and onDismiss provided", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <ErrorDisplay message="dismissable" onDismiss={onDismiss} dismissible />,
    );

    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides dismiss button when dismissible is false", () => {
    render(
      <ErrorDisplay message="no dismiss" onDismiss={vi.fn()} dismissible={false} />,
    );
    expect(
      screen.queryByRole("button", { name: /dismiss/i }),
    ).not.toBeInTheDocument();
  });

  it("hides dismiss button when onDismiss is not provided", () => {
    render(<ErrorDisplay message="no callback" dismissible />);
    expect(
      screen.queryByRole("button", { name: /dismiss/i }),
    ).not.toBeInTheDocument();
  });

  it("renders children content", () => {
    render(
      <ErrorDisplay message="parent">
        <button>retry</button>
      </ErrorDisplay>,
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("InlineError", () => {
  it("renders message when provided", () => {
    render(<InlineError message="Required field" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Required field");
  });

  it("returns null when no message", () => {
    const { container } = render(<InlineError message="" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("FormErrorSummary", () => {
  it("renders error list for non-empty errors", () => {
    render(
      <FormErrorSummary errors={{ email: "invalid", name: "required" }} />,
    );
    expect(screen.getByText(/fix the following errors/i)).toBeInTheDocument();
    expect(screen.getByText(/email/i)).toBeInTheDocument();
    expect(screen.getByText(/name/i)).toBeInTheDocument();
  });

  it("returns null for empty errors", () => {
    const { container } = render(<FormErrorSummary errors={{}} />);
    expect(container.innerHTML).toBe("");
  });

  it("filters out null/undefined error values", () => {
    render(
      <FormErrorSummary errors={{ email: "bad", name: null, age: undefined }} />,
    );
    expect(screen.getByText(/email/i)).toBeInTheDocument();
    expect(screen.queryByText(/name/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/age/i)).not.toBeInTheDocument();
  });

  it("renders retry button when onRetry provided", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <FormErrorSummary errors={{ x: "err" }} onRetry={onRetry} />,
    );

    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("ApiError", () => {
  it("renders error message", () => {
    render(<ApiError error={new Error("connection refused")} />);
    expect(screen.getByText("connection refused")).toBeInTheDocument();
  });

  it("renders default message when error has no message", () => {
    render(<ApiError error={{}} />);
    expect(
      screen.getByText("An unexpected error occurred"),
    ).toBeInTheDocument();
  });

  it("returns null when no error", () => {
    const { container } = render(<ApiError error={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders retry and dismiss buttons", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onDismiss = vi.fn();

    render(
      <ApiError error={new Error("fail")} onRetry={onRetry} onDismiss={onDismiss} />,
    );

    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
