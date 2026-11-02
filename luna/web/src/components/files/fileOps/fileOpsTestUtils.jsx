// Test helper: render UI inside a FileOpsProvider that holds a store built from fixtures.
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { ToastProvider } from "@libreloom/ui/context/ToastContext.jsx";
import { FileOpsProvider } from "../../../context/FileOpsContext.jsx";
import { createFileOpsStore } from "../../../lib/fileOps/store.js";

export function makeStore(initialOps = []) {
  return createFileOpsStore({
    queryClient: { invalidateQueries: vi.fn() },
    addToast: vi.fn(),
    initialOps,
    storage: null,
  });
}

/** @param {import("react").ReactElement} ui */
export function renderWithOps(ui, initialOps = []) {
  const store = makeStore(initialOps);
  const client = new QueryClient();
  const result = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FileOpsProvider store={store}>{ui}</FileOpsProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { store, ...result };
}

export const fileClash = (id, name) => ({
  id,
  name,
  state: "needs-decision",
  decision: { type: "exists", existingKind: "file", options: ["replace", "keep_both", "skip"] },
});

export const folderClash = (id, name) => ({
  id,
  name,
  state: "needs-decision",
  decision: { type: "exists", existingKind: "dir", options: ["keep_both", "skip"] },
});
