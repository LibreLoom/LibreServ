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

it("offers to erase a drive that needs setting up, and never adds it as it is", async () => {
  const onErase = vi.fn(async () => {});
  render(<InspectModal open drive={drive} result={{ needs_setup: true, readable: true, writable: false, entries: [], folders: 0, files: 0 }} error={null} adoptError={null} adopting={false} onClose={() => {}} onAdopt={() => {}} onErase={onErase} />);
  expect(screen.getByText(/It has to be erased first/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add this drive" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Protect with a password" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Erase and set up" }));
  await waitFor(() => expect(onErase).toHaveBeenCalledWith(drive));
});

it("treats a damaged drive the same way, not as a locked switch", () => {
  render(<InspectModal open drive={drive} result={{ readable: false, writable: false, entries: [] }} error={null} adoptError={null} adopting={false} onClose={() => {}} onAdopt={() => {}} onErase={() => {}} />);
  expect(screen.getByText(/It has to be erased first/)).toBeInTheDocument();
  expect(screen.queryByText(/lock switch/)).toBeNull();
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
