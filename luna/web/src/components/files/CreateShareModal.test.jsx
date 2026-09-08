import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import CreateShareModal from "./CreateShareModal";

function wrap(ui) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("CreateShareModal", () => {
  it("disables Create for upload-only links on a single file", async () => {
    const user = userEvent.setup();
    render(wrap(
      <CreateShareModal driveId="d1" path="pic.txt" kind="file" onClose={() => {}} onDone={() => {}} />,
    ));
    await user.click(screen.getByRole("button", { name: "What people with this link can do" }));
    await user.click(screen.getByRole("option", { name: "Upload only" }));
    expect(screen.getByText(/Upload-only links need a folder/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
  });

  it("allows upload-only links on a folder", async () => {
    const user = userEvent.setup();
    render(wrap(
      <CreateShareModal driveId="d1" path="photos" kind="folder" onClose={() => {}} onDone={() => {}} />,
    ));
    await user.click(screen.getByRole("button", { name: "What people with this link can do" }));
    await user.click(screen.getByRole("option", { name: "Upload only" }));
    expect(screen.queryByText(/Upload-only links need a folder/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create link" })).toBeEnabled();
  });
});
