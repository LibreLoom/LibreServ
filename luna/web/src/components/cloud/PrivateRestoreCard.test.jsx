import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider, useToastList } from "@libreloom/ui/context/ToastContext.jsx";
import PrivateRestoreCard from "./PrivateRestoreCard.jsx";
import { getPrivateRestoreStatus, restorePrivateFromPhrase } from "../../lib/privateRestore";

const getPrivateRestoreStatusMock = vi.mocked(getPrivateRestoreStatus);
const restorePrivateFromPhraseMock = vi.mocked(restorePrivateFromPhrase);

let mockUser = { id: "7", role: "member" };

vi.mock("../../context/AuthContext", () => ({
  useOptionalAuth: () => ({ user: mockUser }),
}));

vi.mock("../../lib/privateRestore", async (importOriginal) => ({
  ...(await importOriginal()),
  getPrivateRestoreStatus: vi.fn(),
  restorePrivateFromPhrase: vi.fn(),
}));

const STATUS = {
  needed: true,
  luna_id: "luna-fixture-1",
  signing_public: "AAAA",
  scopes: 1,
};

function ToastProbe() {
  const toasts = useToastList();
  if (toasts.length === 0) return null;
  return (
    <ul>
      {toasts.map((t) => (
        <li key={t.id}>{t.message}</li>
      ))}
    </ul>
  );
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PrivateRestoreCard />
        <ToastProbe />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUser = { id: "7", role: "member" };
  getPrivateRestoreStatusMock.mockResolvedValue(STATUS);
  restorePrivateFromPhraseMock.mockResolvedValue({ restored: 1 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PrivateRestoreCard", () => {
  it("renders nothing when no one is signed in", async () => {
    mockUser = null;
    const { container } = renderCard();
    await waitFor(() => expect(getPrivateRestoreStatus).not.toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when no restore is needed", async () => {
    getPrivateRestoreStatusMock.mockResolvedValue({ ...STATUS, needed: false });
    const { container } = renderCard();
    await waitFor(() => expect(getPrivateRestoreStatus).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("shows a retry when Luna cannot check whether private restore is needed", async () => {
    getPrivateRestoreStatusMock
      .mockRejectedValueOnce(new Error("Connect is unavailable"))
      .mockResolvedValueOnce(STATUS);
    const user = userEvent.setup();
    renderCard();

    expect(
      await screen.findByText("Luna could not check whether your private items need restoring. Try again."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("textbox", { name: "Recovery phrase" })).toBeInTheDocument();
  });

  it("shows the card to a member, not only an Admin", async () => {
    mockUser = { id: "7", role: "member" };
    renderCard();
    expect(await screen.findByText("Bring back your private items")).toBeInTheDocument();
    expect(screen.getByLabelText("Recovery phrase")).toBeInTheDocument();
  });

  it("shows the phishing line and the find button when needed", async () => {
    renderCard();
    expect(await screen.findByText("connect.luna.libreloom.org")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find my private items" })).toBeInTheDocument();
  });

  it("does not show a stop button while private restore runs without cancellation support", async () => {
    /** @type {(value: { restored: number }) => void} */
    let finishRestore = () => {};
    restorePrivateFromPhraseMock.mockImplementation((_, options) => {
      options.onProgress?.({ processed: 1, total: 2, snapshots: 1, already_indexed: 0, skipped: 0 });
      return new Promise((resolve) => {
        finishRestore = resolve;
      });
    });
    const user = userEvent.setup();
    renderCard();
    await user.type(await screen.findByLabelText("Recovery phrase"), "one two three");
    await user.click(screen.getByRole("button", { name: "Find my private items" }));

    await waitFor(() => expect(restorePrivateFromPhrase).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Stop restore" })).not.toBeInTheDocument();
    expect(await screen.findByText("Restoring backup 1 of 2")).toBeInTheDocument();

    finishRestore({ restored: 1 });
    expect(await screen.findByText("Found 1 private version")).toBeInTheDocument();
  });

  it("explains a missing signing key instead of the phrase form", async () => {
    getPrivateRestoreStatusMock.mockResolvedValue({ ...STATUS, signing_public: null });
    renderCard();
    expect(
      await screen.findByText(
        "Luna hasn't found its backup signing key yet. Connect the drives that were in this Luna, then reload this page.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Recovery phrase")).not.toBeInTheDocument();
  });

  it("submits the phrase and shows a success toast", async () => {
    const user = userEvent.setup();
    renderCard();
    const field = await screen.findByLabelText("Recovery phrase");
    await user.type(field, "one two three");
    await user.click(screen.getByRole("button", { name: "Find my private items" }));

    await waitFor(() =>
      expect(restorePrivateFromPhrase).toHaveBeenCalledWith("one two three", expect.objectContaining({
        lunaId: "luna-fixture-1",
        signingPublic: "AAAA",
        onProgress: expect.any(Function),
      })),
    );
    expect(await screen.findByText("Found 1 private version")).toBeInTheDocument();
    expect(field).toHaveValue("");
  });

  it("uses the plural toast for several versions", async () => {
    restorePrivateFromPhraseMock.mockResolvedValue({ restored: 4 });
    const user = userEvent.setup();
    renderCard();
    const field = await screen.findByLabelText("Recovery phrase");
    await user.type(field, "one two three");
    await user.click(screen.getByRole("button", { name: "Find my private items" }));

    expect(await screen.findByText("Found 4 private versions")).toBeInTheDocument();
  });

  it("shows the error inline and no toast when the restore fails", async () => {
    restorePrivateFromPhraseMock.mockRejectedValue(new Error("Check each word."));
    const user = userEvent.setup();
    renderCard();
    const field = await screen.findByLabelText("Recovery phrase");
    await user.type(field, "wrong words");
    await user.click(screen.getByRole("button", { name: "Find my private items" }));

    expect(await screen.findByText("Check each word.")).toBeInTheDocument();
    expect(screen.queryByText(/Found \d+ private/)).not.toBeInTheDocument();
    expect(field).toHaveValue("");
  });
});
