import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import Toaster from "@libreloom/ui/components/common/Toaster.jsx";
import RecoveryPhraseCard, { MovingNote } from "./RecoveryPhraseCard.jsx";
import AllBackupsModal from "../dashboard/AllBackupsModal.jsx";
import { movingPercent } from "../../lib/movingPercent.js";

vi.mock("../../context/AuthContext.jsx", () => ({
  useOptionalAuth: () => ({ user: { id: "u1", role: "admin" } }),
  useAuth: () => ({ user: { id: "u1", role: "admin" } }),
}));
vi.mock("../files/ProtectSheet.jsx", () => ({ default: () => null }));

const FULL_TEXT = /Connect storage is full, so the move is paused\. Nothing old was deleted\. Free up space or add storage/;

function stubFetch(phrase) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = String(url);
    const body = path.includes("phrase") ? phrase : path.endsWith("/summary") ? { owners: [] } : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

function wrap(ui) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastProvider>
          {ui}
          <Toaster />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const PHRASE = { set: true, set_at: 1700000000, luna_id: "luna-1", signing_public: "x", check_due: false, last_checked_at: 1700000000 };
const BACKUP = {
  id: "c1", kind: "cloud", source_name: "Documents", source_path: "Documents", destination: "Luna Connect",
  state: "ok", status: "active", last_ok_at: 1700000000, created_by: "u1", can_delete: true,
};

afterEach(() => vi.unstubAllGlobals());

describe("movingPercent", () => {
  it("rounds down and clamps between 0 and 100", () => {
    expect(movingPercent({ percent: 40.9 })).toBe(40);
    expect(movingPercent({ percent: 99.99 })).toBe(99);
    expect(movingPercent({ percent: -5 })).toBe(0);
    expect(movingPercent({ percent: 250 })).toBe(100);
    expect(movingPercent({ percent: "oops" })).toBe(0);
    expect(movingPercent({})).toBe(0);
  });
});

describe("MovingNote", () => {
  it("is hidden when nothing is moving", () => {
    const { container } = render(<MovingNote moving={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the rounded percent with no pause message", () => {
    render(<MovingNote moving={{ percent: 40.9, paused_full: false }} />);
    expect(screen.getByText("Moving to your new phrase · 40%")).toBeInTheDocument();
    expect(screen.queryByText(FULL_TEXT)).toBeNull();
  });

  it("explains a pause when Connect storage is full", () => {
    render(<MovingNote moving={{ percent: 40, paused_full: true }} />);
    expect(screen.getByText("Moving to your new phrase · 40%")).toBeInTheDocument();
    expect(screen.getByText(FULL_TEXT)).toBeInTheDocument();
  });
});

describe("RecoveryPhraseCard moving status", () => {
  it("shows the percent as a neutral line with no toast", async () => {
    stubFetch({ ...PHRASE, moving: { percent: 40.2, paused_full: false } });
    wrap(<RecoveryPhraseCard />);
    expect(await screen.findByText("Moving to your new phrase · 40%")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("shows the pause message inline when storage is full", async () => {
    stubFetch({ ...PHRASE, moving: { percent: 40, paused_full: true } });
    wrap(<RecoveryPhraseCard />);
    expect(await screen.findByText(FULL_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows nothing when moving is null", async () => {
    stubFetch({ ...PHRASE, moving: null });
    wrap(<RecoveryPhraseCard />);
    await screen.findByText("Ready");
    expect(screen.queryByText(/Moving to your new phrase/)).toBeNull();
  });
});

describe("AllBackupsModal moving status", () => {
  it("shows the percent on a moving backup row, and nothing on others", async () => {
    stubFetch(PHRASE);
    wrap(
      <AllBackupsModal
        open
        onClose={() => {}}
        backups={[
          { ...BACKUP, moving: { percent: 40.7, paused_full: false } },
          { ...BACKUP, id: "c2", source_name: "Music", moving: null },
        ]}
      />,
    );
    expect(await screen.findByText("Moving to your new phrase · 40%")).toBeInTheDocument();
    expect(screen.getAllByText(/Moving to your new phrase/)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Back up now" })).toHaveLength(2);
  });

  it("shows the pause message on a paused row", async () => {
    stubFetch(PHRASE);
    wrap(<AllBackupsModal open onClose={() => {}} backups={[{ ...BACKUP, moving: { percent: 10, paused_full: true } }]} />);
    expect(await screen.findByText(FULL_TEXT)).toBeInTheDocument();
  });
});
