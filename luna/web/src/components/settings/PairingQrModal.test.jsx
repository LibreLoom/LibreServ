import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const toCanvas = vi.fn();
vi.mock("qrcode", () => ({ toCanvas: (...args) => toCanvas(...args) }));

import PairingQrModal from "./PairingQrModal.jsx";
import { encodePairing } from "../../lib/pairing.js";

describe("PairingQrModal", () => {
  afterEach(() => toCanvas.mockReset());

  it("draws the address and token as a QR code and warns who can use it", async () => {
    toCanvas.mockResolvedValue(undefined);
    render(<PairingQrModal open token="tok-123" onClose={() => {}} />);
    await waitFor(() => expect(toCanvas).toHaveBeenCalled());
    const [canvas, payload] = toCanvas.mock.calls[0];
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(payload).toBe(encodePairing(window.location.origin, "tok-123"));
    expect(screen.getByText(/Anyone who scans it can reach your files/)).toBeInTheDocument();
    expect(screen.getByLabelText("QR code for Luna address and access token")).toBeInTheDocument();
  });

  it("falls back to telling the person to copy the token when drawing fails", async () => {
    toCanvas.mockRejectedValue(new Error("no canvas"));
    render(<PairingQrModal open token="tok-123" onClose={() => {}} />);
    expect(await screen.findByText(/Could not draw the QR code\. Copy the access token instead\./)).toBeInTheDocument();
  });

  it("draws nothing while closed or without a token", () => {
    render(<PairingQrModal open={false} token="tok-123" onClose={() => {}} />);
    render(<PairingQrModal open token="" onClose={() => {}} />);
    expect(toCanvas).not.toHaveBeenCalled();
  });

  it("closes from Done", async () => {
    toCanvas.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<PairingQrModal open token="tok" onClose={onClose} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
