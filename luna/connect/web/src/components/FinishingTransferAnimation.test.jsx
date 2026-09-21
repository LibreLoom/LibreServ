import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FinishingTransferAnimation } from "./FinishingTransferAnimation.jsx";

describe("FinishingTransferAnimation", () => {
  it("renders the LibreServ (Luna) and Cloudflare nodes with region label", () => {
    render(<FinishingTransferAnimation />);
    expect(screen.getByRole("region", { name: /Connecting Luna to Cloudflare domain/i })).toBeTruthy();
    expect(screen.getByLabelText("LibreServ")).toBeTruthy();
    expect(screen.getByLabelText("Cloudflare")).toBeTruthy();
  });
});
