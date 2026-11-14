import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import InspectModal from "./InspectModal.jsx";

const drive = { name: "sdb", model: "USB drive" };

function show(result, onAdopt = () => {}) {
  render(<InspectModal open drive={drive} result={result} error={null} adoptError={null} adopting={false} onClose={() => {}} onAdopt={onAdopt} />);
}

it("says plainly that Luna can't open an encrypted drive, and offers no way forward", () => {
  show({ encrypted: true, readable: false, writable: false, entries: [] });
  expect(screen.getByText("Luna can't open encrypted drives in this version yet.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add this drive" })).toBeNull();
  expect(screen.queryByLabelText("Drive password")).toBeNull();
});

it("says plainly that a drive that needs setting up can't be added yet", () => {
  show({ needs_setup: true, readable: true, writable: false, entries: [], folders: 0, files: 0 });
  expect(screen.getByText("Setting up new drives isn't available in this version yet.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add this drive" })).toBeNull();
});

it("adds a readable, writable drive under the name the person chose", async () => {
  const onAdopt = vi.fn(async () => {});
  show({ readable: true, writable: true, entries: [], folders: 0, files: 0 }, onAdopt);
  fireEvent.change(screen.getByLabelText("Drive name"), { target: { value: "Photos" } });
  fireEvent.click(screen.getByRole("button", { name: "Add this drive" }));
  await waitFor(() => expect(onAdopt).toHaveBeenCalledWith("Photos"));
});

it("explains a drive Luna can't save to", () => {
  show({ readable: true, writable: false, entries: [], folders: 0, files: 0 });
  expect(screen.getByText(/can't save files to this drive/)).toBeInTheDocument();
});
