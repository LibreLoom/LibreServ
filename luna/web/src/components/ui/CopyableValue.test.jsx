import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CopyableValue from "./CopyableValue.jsx";

describe("CopyableValue", () => {
  const originalClipboard = navigator.clipboard;
  const originalSecure = window.isSecureContext;

  afterEach(() => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      get: () => originalSecure,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  });

  describe("secure context", () => {
    beforeEach(() => {
      Object.defineProperty(window, "isSecureContext", {
        configurable: true,
        get: () => true,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn(async () => undefined) },
      });
    });

    it("shows a Copy button and copies on click", async () => {
      const user = userEvent.setup();
      render(<CopyableValue value="https://luna.example/s/abc" copyLabel="Copy address" />);
      const btn = screen.getByRole("button", { name: "Copy address" });
      expect(btn).toBeTruthy();
      expect(screen.queryByText(/Select the text below/i)).toBeNull();
      await user.click(btn);
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://luna.example/s/abc");
      expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    });
  });

  describe("insecure context", () => {
    beforeEach(() => {
      Object.defineProperty(window, "isSecureContext", {
        configurable: true,
        get: () => false,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn(async () => undefined) },
      });
    });

    it("shows selectable text and guidance instead of a Copy button", () => {
      render(
        <CopyableValue
          value="http://192.168.1.10/s/abc"
          copyLabel="Copy address"
          ariaLabel="Share link"
        />,
      );
      expect(screen.getByText(/Select the text below, then copy it/i)).toBeTruthy();
      expect(screen.getByLabelText("Share link")).toHaveValue("http://192.168.1.10/s/abc");
      expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });
  });
});
