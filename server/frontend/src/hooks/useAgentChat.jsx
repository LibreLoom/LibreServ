import { useState, useRef, useCallback, useEffect } from "react";
import { useAuth } from "./useAuth.jsx";

export function useAgentChat() {
  const { request } = useAuth();
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
      const data = await res.json();
      setConversations(data.conversations || []);
    } catch {
      setError("Could not load your conversation history. Please try again later.");
    }
  }, [request]);

  const loadConversation = useCallback(async (convId) => {
    try {
      const res = await request(`/support/agent/conversations/${convId}`);
      if (!res.ok) throw new Error("not found");
      const data = await res.json();
      setActiveConv(data.conversation);
      setMessages(data.messages || []);
    } catch {
      setError("Could not load this conversation. It may have been deleted.");
    }
  }, [request]);

  const loadSubscription = useCallback(async () => {
    try {
      const res = await request("/support/agent/subscription");
      if (!res.ok) return;
      const data = await res.json();
      setSubscription(data);
    } catch {
      // non-critical
    }
  }, [request]);

  const loadModels = useCallback(async () => {
    try {
      const res = await request("/support/agent/models");
      if (!res.ok) return;
      const data = await res.json();
      setModels(data.models || []);
    } catch {
      // non-critical
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
          trigger_app_id: opts.triggerAppId || "",
          permission_mode: opts.permissionMode || "standard",
          models: opts.models || [],
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Could not start a new conversation.");
      }
      const data = await res.json();
      setActiveConv(data);
      setMessages([]);
      setEvents([]);
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [request]);

  const sendMessage = useCallback(async (convId, content) => {
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

  const streamEvents = useCallback((convId) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const baseUrl = window.location.origin;
    const url = new URL(`${baseUrl}/api/v1/support/agent/conversations/${convId}/stream`);

    const es = new EventSource(url.toString(), { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => {
      setStatus("streaming");
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setEvents((prev) => [...prev, data]);

        if (data.type === "agent_response") {
          setMessages((prev) => [...prev, { role: "assistant", content: data.content, created_at: new Date().toISOString() }]);
        }
        if (data.type === "permission_request") {
          // permission cards are rendered from events, no message added
        }
        if (data.type === "snapshot_created") {
          // snapshot pills rendered from events
        }
        if (data.type === "done") {
          setStatus(data.reason === "complete" ? "complete" : "idle");
          es.close();
          eventSourceRef.current = null;
        }
        if (data.type === "error") {
          setError(data.message || "Something went wrong while the agent was working.");
          setStatus("error");
          es.close();
          eventSourceRef.current = null;
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      if (statusRef.current !== "complete") {
        setStatus("idle");
      }
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  const respondPermission = useCallback(async (convId, toolCallId, approved) => {
    try {
      await request(`/support/agent/conversations/${convId}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool_call_id: toolCallId, approved }),
      });
    } catch {
      // permission response failed
    }
  }, [request]);

  const stopConversation = useCallback(async (convId) => {
    try {
      await request(`/support/agent/conversations/${convId}/stop`, { method: "POST" });
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setStatus("idle");
    } catch {
      // stop failed
    }
  }, [request]);

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
      // plan selection failed
    }
  }, [request]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
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
  };
}
