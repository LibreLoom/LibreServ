import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider, useToastList } from "@libreloom/ui/context/ToastContext.jsx";
import CloudRestoreCard from "./CloudRestoreCard.jsx";
import { getRestoreStatus, restoreFromPhrase } from "../../lib/cloudRestore";
import { getPhraseStatus } from "../../lib/cloudPhrase";

const getRestoreStatusMock = vi.mocked(getRestoreStatus);
const restoreFromPhraseMock = vi.mocked(restoreFromPhrase);
const getPhraseStatusMock = vi.mocked(getPhraseStatus);

let mockUser = { id: "42", role: "admin" };

vi.mock("../../context/AuthContext", () => ({
  useOptionalAuth: () => ({ user: mockUser }),
}));

vi.mock("../../lib/cloudRestore", async (importOriginal) => ({
  ...(await importOriginal()),
  getRestoreStatus: vi.fn(),
  restoreFromPhrase: vi.fn(),
}));

vi.mock("../../lib/cloudPhrase", async (importOriginal) => ({
  ...(await importOriginal()),
  getPhraseStatus: vi.fn(),
}));

const STATUS = {
  needed: true,
  luna_id: "luna-fixture-1",
  signing_public: "AAAA",
  cloud_snapshots: 5,
  indexed_snapshots: 0,
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
        <CloudRestoreCard />
        <ToastProbe />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockUser = { id: "42", role: "admin" };
  getRestoreStatusMock.mockResolvedValue(STATUS);
  getPhraseStatusMock.mockResolvedValue({ set: true });
  restoreFromPhraseMock.mockResolvedValue({ snapshots: 3, alreadyIndexed: 0, skipped: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("CloudRestoreCard", () => {
  it("renders nothing for a member", async () => {
    mockUser = { id: "7", role: "member" };
    const { container } = renderCard();
    await waitFor(() => expect(getRestoreStatus).not.toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when no restore is needed", async () => {
    getRestoreStatusMock.mockResolvedValue({ ...STATUS, needed: false });
    const { container } = renderCard();
    await waitFor(() => expect(getRestoreStatus).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("shows the title, the counts and the phishing line for an Admin", async () => {
    renderCard();
    expect(await screen.findByText("Bring back cloud backups")).toBeInTheDocument();
    expect(screen.getByText(/5 versions are in the cloud/)).toBeInTheDocument();
    expect(screen.getByText(/0 are on Luna/)).toBeInTheDocument();
    expect(screen.getByText("connect.luna.libreloom.org")).toBeInTheDocument();
    expect(screen.getByLabelText("Recovery phrase")).toBeInTheDocument();
  });

  it("uses singular verbs for one version", async () => {
    getRestoreStatusMock.mockResolvedValue({ ...STATUS, cloud_snapshots: 1, indexed_snapshots: 1 });
    renderCard();
    expect(await screen.findByText(/1 version is in the cloud/)).toBeInTheDocument();
    expect(screen.getByText(/1 is on Luna/)).toBeInTheDocument();
  });

  it("explains a missing signing key instead of the phrase form", async () => {
    getRestoreStatusMock.mockResolvedValue({ ...STATUS, signing_public: null });
    renderCard();
    expect(
      await screen.findByText(
        "Luna hasn't found its backup signing key yet. Connect the drives that were in this Luna, then reload this page.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Recovery phrase")).not.toBeInTheDocument();
  });

  it("submits the words with the restore context and shows a toast", async () => {
    const user = userEvent.setup();
    renderCard();
    const field = await screen.findByLabelText("Recovery phrase");
    await user.type(field, "one two three");
    await user.click(screen.getByRole("button", { name: "Find my backups" }));

    await waitFor(() =>
      expect(restoreFromPhrase).toHaveBeenCalledWith("one two three", {
        lunaId: "luna-fixture-1",
        signingPublic: "AAAA",
        userId: "42",
        phraseSet: true,
      }, expect.any(Function), expect.any(AbortSignal)),
    );
    expect(await screen.findByText("Found 3 backup versions")).toBeInTheDocument();
    expect(field).toHaveValue("");
  });

  it("shows the server's incremental restore progress while work is running", async () => {
    /** @type {(value: { snapshots: number, alreadyIndexed: number, skipped: number }) => void} */
    let finish = () => {};
    restoreFromPhraseMock.mockImplementation((_words, _ctx, onProgress) => {
      onProgress({ processed: 2, total: 5, snapshots: 1, already_indexed: 1, skipped: 0 });
      return new Promise((resolve) => { finish = resolve; });
    });
    const user = userEvent.setup();
    renderCard();
    await user.type(await screen.findByLabelText("Recovery phrase"), "one two three");
    await user.click(screen.getByRole("button", { name: "Find my backups" }));
    expect(await screen.findByText("Restoring backup 2 of 5")).toBeInTheDocument();
    expect(screen.getByLabelText("Cloud backup restore progress")).toHaveAttribute("value", "2");
    finish({ snapshots: 1, alreadyIndexed: 1, skipped: 0 });
    expect(await screen.findByText("Found 2 backup versions")).toBeInTheDocument();
  });

  it("lets the Admin stop the streamed restore and explains that retry is safe", async () => {
    restoreFromPhraseMock.mockImplementation((_words, _ctx, _onProgress, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Restore stopped", "AbortError")), { once: true });
    }));
    const user = userEvent.setup();
    renderCard();
    await user.type(await screen.findByLabelText("Recovery phrase"), "one two three");
    await user.click(screen.getByRole("button", { name: "Find my backups" }));
    await user.click(await screen.findByRole("button", { name: "Stop restore" }));
    expect(await screen.findByText(/Restore stopped\. Some backup versions may already be back/)).toBeInTheDocument();
  });

  it("shows the error message when the restore fails", async () => {
    restoreFromPhraseMock.mockRejectedValue(new Error("Check each word."));
    const user = userEvent.setup();
    renderCard();
    const field = await screen.findByLabelText("Recovery phrase");
    await user.type(field, "wrong words");
    await user.click(screen.getByRole("button", { name: "Find my backups" }));

    expect(await screen.findByText("Check each word.")).toBeInTheDocument();
    expect(field).toHaveValue("");
  });
});
