import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { AuthContext } from "../context/AuthContextContext.js";
import { ToastProvider } from "../context/ToastContext.jsx";
import { useAgentChat } from "./useAgentChat.jsx";

function mockRequest(url, opts = {}) {
  const routes = {
    "/support/agent/conversations": {
      GET: { conversations: [{ id: "c1", status: "active" }] },
      POST: { id: "c_new", status: "active" },
    },
    "/support/agent/conversations/c1": {
      GET: { conversation: { id: "c1", status: "active" }, messages: [{ role: "assistant", content: "hi" }] },
    },
    "/support/agent/subscription": {
      GET: { plan_id: "free", credit_cap: 0 },
      PUT: { plan_id: "basic", credit_cap: 10 },
    },
    "/support/agent/models": {
      GET: { models: ["mimo-v2.5-pro", "kimi-k2.6"] },
    },
    "/support/agent/conversations/c1/messages": {
      POST: { ok: true },
    },
    "/support/agent/conversations/c1/permission": {
      POST: { ok: true },
    },
    "/support/agent/conversations/c1/stop": {
      POST: { ok: true },
    },
  };

  const key = url.replace("/api/v1", "");
  const route = routes[key];
  if (!route) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });

  const method = (opts.method || "GET").toUpperCase();
  const body = route[method] || route.GET;
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

function createWrapper() {
  const mockAuth = {
    me: { id: "u1", username: "test" },
    csrfToken: "tok",
    request: vi.fn(mockRequest),
    initialized: true,
  };
  return {
    wrapper: ({ children }) => (
      <AuthContext.Provider value={mockAuth}>
        <ToastProvider>{children}</ToastProvider>
      </AuthContext.Provider>
    ),
    mockAuth,
  };
}

describe("useAgentChat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with idle status and empty state", () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAgentChat(), { wrapper });
    expect(result.current.status).toBe("idle");
    expect(result.current.messages).toEqual([]);
    expect(result.current.events).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it("loads conversations", async () => {
    const { wrapper, mockAuth } = createWrapper();
    const { result } = renderHook(() => useAgentChat(), { wrapper });

    await act(() => result.current.loadConversations());
    await waitFor(() => {
      expect(result.current.conversations).toHaveLength(1);
      expect(result.current.conversations[0].id).toBe("c1");
    });
    expect(mockAuth.request).toHaveBeenCalledWith("/support/agent/conversations");
  });

  it("loads a single conversation with messages", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAgentChat(), { wrapper });

    await act(() => result.current.loadConversation("c1"));
    await waitFor(() => {
      expect(result.current.activeConv).toBeTruthy();
      expect(result.current.messages).toHaveLength(1);
    });
  });

  it("loads subscription", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAgentChat(), { wrapper });

    await act(() => result.current.loadSubscription());
    await waitFor(() => {
      expect(result.current.subscription).toBeTruthy();
      expect(result.current.subscription.plan_id).toBe("free");
    });
  });

  it("loads models", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAgentChat(), { wrapper });

    await act(() => result.current.loadModels());
    await waitFor(() => {
      expect(result.current.models).toEqual(["mimo-v2.5-pro", "kimi-k2.6"]);
    });
  });

  it("starts a new conversation", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAgentChat(), { wrapper });

    await act(async () => {
      await result.current.startConversation();
    });
    await waitFor(() => {
      expect(result.current.activeConv).toBeTruthy();
      expect(result.current.events).toEqual([]);
    });
  });

  it("sends a message and updates status", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAgentChat(), { wrapper });

    let ok;
    await act(async () => {
      ok = await result.current.sendMessage("c1", "hello");
    });
    await waitFor(() => {
      expect(ok).toBe(true);
      expect(result.current.status).toBe("streaming");
      expect(result.current.messages).toHaveLength(1);
      expect(result.current.messages[0].content).toBe("hello");
    });
  });

  it("selects a plan", async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAgentChat(), { wrapper });

    await act(() => result.current.selectPlan("basic"));
    await waitFor(() => {
      expect(result.current.subscription.plan_id).toBe("basic");
    });
  });

  it("responds to permission request", async () => {
    const { wrapper, mockAuth } = createWrapper();
    const { result } = renderHook(() => useAgentChat(), { wrapper });

    await act(() => result.current.respondPermission("c1", "tc_1", true));
    expect(mockAuth.request).toHaveBeenCalledWith(
      "/support/agent/conversations/c1/permission",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("stops a conversation", async () => {
    const { wrapper, mockAuth } = createWrapper();
    const { result } = renderHook(() => useAgentChat(), { wrapper });

    await act(() => result.current.stopConversation("c1"));
    expect(mockAuth.request).toHaveBeenCalledWith(
      "/support/agent/conversations/c1/stop",
      { method: "POST" }
    );
    expect(result.current.status).toBe("idle");
  });

  it("sets error on failed load", async () => {
    const mockAuth = {
      me: { id: "u1" },
      csrfToken: "tok",
      request: vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })),
      initialized: true,
    };
    const wrapper = ({ children }) => (
      <AuthContext.Provider value={mockAuth}>
        <ToastProvider>{children}</ToastProvider>
      </AuthContext.Provider>
    );

    const { result } = renderHook(() => useAgentChat(), { wrapper });

    await act(() => result.current.loadConversations());
    await waitFor(() => {
      expect(result.current.error).toBeTruthy();
    });
  });

  it("exposes setError for manual clear", () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useAgentChat(), { wrapper });

    act(() => result.current.setError("test error"));
    expect(result.current.error).toBe("test error");
    act(() => result.current.setError(null));
    expect(result.current.error).toBeNull();
  });
});
