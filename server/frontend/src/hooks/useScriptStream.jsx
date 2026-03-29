import { useState, useRef, useCallback, useEffect } from "react";

export function useScriptStream() {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | connecting | streaming | complete | error
  const [exitCode, setExitCode] = useState(null);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const connect = useCallback((url) => {
    disconnect();
    setLines([]);
    setStatus("connecting");
    setExitCode(null);
    setError(null);

    const es = new EventSource(url, { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => {
      setStatus("streaming");
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "complete") {
          setExitCode(data.exit_code ?? 0);
          setStatus(data.exit_code === 0 ? "complete" : "error");
          es.close();
          eventSourceRef.current = null;
          return;
        }

        if (data.type === "error") {
          setError(data.error || "An error occurred");
          setStatus("error");
          es.close();
          eventSourceRef.current = null;
          return;
        }

        setLines((prev) => [...prev, data]);
      } catch {
        // Ignore parse errors for non-JSON SSE data
      }
    };

    es.onerror = () => {
      if (status !== "complete" && status !== "error") {
        setError("Connection to server lost");
        setStatus("error");
      }
      es.close();
      eventSourceRef.current = null;
    };
  }, [disconnect, status]);

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, []);

  return { lines, status, exitCode, error, connect, disconnect };
}
