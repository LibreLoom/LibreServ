import { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "./useAuth.jsx";
import { useToast } from "../context/ToastContext";

export function useAgentChat() {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [conversations, setConversations] = useState([]);
  const [activeConv, setActiveConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [models, setModels] = useState([]);
  const eventSourceRef = useRef(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const loadConversations = useCallback(async () => {
    try {
      const res = await request("/support/agent/conversations");
      if (!res.ok) throw new Error("failed to load conversations");
      const result = await res.json();
      const data = result.data || result;
      setConversations(data.conversations || []);
    } catch {
      setError("Could not load your conversation history. Please try again later.");
    }
  }, [request]);

  const loadConversation = useCallback(async (convId) => {
    try {
      const res = await request(`/support/agent/conversations/${convId}`);
      if (!res.ok) throw new Error("not found");
      const result = await res.json();
      const data = result.data || result;
      setStatus("idle");
      setError(null);
      setActiveConv(data.conversation);
      setMessages(data.messages || []);
      const loadedEvents = (data.events || []).map((e) => {
        let evtData = {};
        try {
          evtData = JSON.parse(e.event_data || "{}");
        } catch {
          evtData = {};
        }
        const data = evtData.data || {};
        if (evtData.type === "proposal" && data.type !== undefined) {
          data.proposal_type = data.type;
          delete data.type;
        }
        return { ...data, type: evtData.type || e.event_type };
      });
      setEvents(loadedEvents);
    } catch {
      setError("Could not load this conversation. It may have been deleted.");
    }
  }, [request]);

  const loadSubscription = useCallback(async () => {
    try {
      const res = await request("/support/agent/subscription");
      if (!res.ok) return;
      const result = await res.json();
      setSubscription(result.data || result);
    } catch {
      // Silently ignore — non-critical background load
    }
  }, [request]);

  const loadModels = useCallback(async () => {
    try {
      const res = await request("/support/agent/models");
      if (!res.ok) return;
      const result = await res.json();
      const data = result.data || result;
      setModels(data.models || []);
    } catch {
      // Silently ignore — non-critical background load
    }
  }, [request]);

  const startConversation = useCallback(async (opts = {}) => {
    try {
      setError(null);
      const res = await request("/support/agent/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trigger_type: opts.triggerType || "manual",
          ...(opts.triggerAppId ? { trigger_app_id: opts.triggerAppId } : {}),
          permission_mode: opts.permissionMode || "standard",
          models: opts.models || [],
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not start a new conversation.");
      }
      const result = await res.json();
      const conv = result.data || result;
      setActiveConv(conv);
      setConversations((prev) => {
        const existing = (prev || []).filter((c) => c.id !== conv.id);
        return [conv, ...existing];
      });
      setMessages([]);
      setEvents([]);
      return conv;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [request]);

  const sendMessage = useCallback(async (convId, content) => {
    if (statusRef.current === "sending" || statusRef.current === "streaming") {
      return false;
    }
    try {
      setError(null);
      setStatus("sending");
      const res = await request(`/support/agent/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not send your message.");
      }
      setMessages((prev) => [...prev, { role: "user", content, created_at: new Date().toISOString() }]);
      setStatus("streaming");
      return true;
    } catch (err) {
      setError(err.message);
      setStatus("idle");
      return false;
    }
  }, [request]);

  const streamEvents = useCallback((convId, attempt = 1) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const baseUrl = window.location.origin;
    const url = new URL(`${baseUrl}/api/v1/support/agent/conversations/${convId}/stream`);

    let opened = false;
    let doneReceived = false;
    const es = new EventSource(url.toString(), { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => {
      opened = true;
      setStatus("streaming");
    };

    es.onmessage = (event) => {
      try {
        const rawEvt = JSON.parse(event.data);
        const data = { ...(rawEvt.data || {}) };
        // Rename ProposalData.Type to proposal_type to avoid collision with top-level type
        if (rawEvt.type === "proposal" && data.type !== undefined) {
          data.proposal_type = data.type;
          delete data.type;
        }
        const flatEvt = { ...data, type: rawEvt.type };
        setEvents((prev) => [...prev, flatEvt]);

        if (flatEvt.type === "agent_response") {
          const resp = flatEvt;
          setMessages((prev) => [...prev, { role: "assistant", content: resp.content, created_at: new Date().toISOString() }]);
        }
        if (flatEvt.type === "permission_request") {
          // permission cards are rendered from events, no message added
        }
        if (flatEvt.type === "snapshot_created") {
          // snapshot pills rendered from events
        }
        if (flatEvt.type === "done") {
          doneReceived = true;
          const d = flatEvt;
          setStatus(d.reason === "complete" ? "complete" : "idle");
          const newStatus = d.reason === "user_stopped" ? "cancelled" : "resolved";
          setConversations((prev) =>
            prev.map((c) => (c.id === convId ? { ...c, status: newStatus } : c))
          );
          setActiveConv((prev) => (prev && prev.id === convId ? { ...prev, status: newStatus } : prev));
          es.close();
          eventSourceRef.current = null;
        }
        if (flatEvt.type === "error") {
          doneReceived = true;
          const err = flatEvt;
          setError(err.message || "Something went wrong while the agent was working.");
          setStatus("error");
          es.close();
          eventSourceRef.current = null;
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      if (doneReceived) return;
      es.close();
      eventSourceRef.current = null;

      // If the connection never opened, the agent loop may not have started yet.
      // Retry once after a short delay.
      if (!opened && attempt < 2) {
        setTimeout(() => streamEvents(convId, attempt + 1), 1500);
        return;
      }

      if (!opened) {
        addToast({
          type: "error",
          message: "Could not connect to the AI assistant. The agent may not have started — check your AI provider settings and try again.",
        });
      }
      if (statusRef.current !== "complete") {
        setStatus("idle");
      }
    };
  }, [addToast]);

  const respondPermission = useCallback(async (convId, toolCallId, approved) => {
    try {
      await request(`/support/agent/conversations/${convId}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool_call_id: toolCallId, approved }),
      });
    } catch {
      addToast({ type: "error", message: "Could not send your permission response. Please try again." });
    }
  }, [request, addToast]);

  const stopConversation = useCallback(async (convId) => {
    try {
      await request(`/support/agent/conversations/${convId}/stop`, { method: "POST" });
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setStatus("idle");
    } catch {
      addToast({ type: "error", message: "Could not stop the agent. Please try again." });
    }
  }, [request, addToast]);

  const selectPlan = useCallback(async (planId) => {
    try {
      const res = await request("/support/agent/subscription", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: planId }),
      });
      if (!res.ok) throw new Error("failed to select plan");
      const data = await res.json();
      setSubscription(data);
    } catch {
      addToast({ type: "error", message: "Could not update your plan. Please try again." });
    }
  }, [request, addToast]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  const resetChat = useCallback(() => {
    setActiveConv(null);
    setMessages([]);
    setEvents([]);
    setError(null);
    setStatus("idle");
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  return {
    conversations,
    activeConv,
    messages,
    events,
    status,
    error,
    subscription,
    models,
    loadConversations,
    loadConversation,
    loadSubscription,
    loadModels,
    startConversation,
    sendMessage,
    streamEvents,
    respondPermission,
    stopConversation,
    selectPlan,
    setError,
    resetChat,
  };
}
