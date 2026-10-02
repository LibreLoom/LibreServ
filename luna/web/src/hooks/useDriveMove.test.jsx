import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import useDriveMove from "./useDriveMove.js";

const api = vi.hoisted(() => ({ postJson: vi.fn() }));
const toasts = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...(await original()), postJson: api.postJson }));
vi.mock("@libreloom/ui/context/ToastContext.jsx", () => ({ useToast: () => toasts }));

function renderMove(onBroaden) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return renderHook(() => useDriveMove({ driveId: "d1", onBroaden }), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}

describe("useDriveMove privacy confirmation", () => {
  it("retries only items that have not already been submitted", async () => {
    api.postJson.mockReset().mockResolvedValueOnce({ id: "first" })
      .mockRejectedValueOnce(Object.assign(new Error("Confirm access"), { code: "broadens_access" }))
      .mockResolvedValue({ id: "next" });
    const onBroaden = vi.fn();
    const { result } = renderMove(onBroaden);
    await act(async () => {
      await result.current.mutateAsync({ paths: ["Private/Nested", "Private/file.txt", "Private/other.txt"], destDriveId: "d2" }).catch(() => {});
    });
    expect(onBroaden).toHaveBeenCalledOnce();
    await act(async () => { await onBroaden.mock.calls[0][0](); });
    expect(api.postJson.mock.calls.map(([, body]) => body.from_path)).toEqual([
      "Private/Nested", "Private/file.txt", "Private/file.txt", "Private/other.txt",
    ]);
    expect(api.postJson.mock.calls.slice(2).every(([, body]) => body.confirm_broaden === true)).toBe(true);
  });
});
