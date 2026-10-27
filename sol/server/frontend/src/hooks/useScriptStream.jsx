import { useState, useRef, useCallback, useEffect } from "react";

export function useScriptStream() {
  const [lines, setLines] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | connecting | streaming | complete | error
  const [exitCode, setExitCode] = useState(null);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);
  const pendingConnectRef = useRef(null);

  const disconnect = useCallback(() => {
    if (pendingConnectRef.current !== null) {
      clearTimeout(pendingConnectRef.current);
      pendingConnectRef.current = null;
    }
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

    // Start after the current effect pass. React StrictMode immediately runs
    // setup → cleanup → setup in development; deferring lets its first cleanup
    // cancel this pending connection before it can consume the one-use stream.
    pendingConnectRef.current = setTimeout(() => {
      pendingConnectRef.current = null;
      const es = new EventSource(url, { withCredentials: true });
      eventSourceRef.current = es;

      es.onopen = () => {
        setStatus("streaming");
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === "complete") {
            const code = data.exit_code ?? 0;
            setExitCode(code);
            setStatus(code === 0 ? "complete" : "error");
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
        if (eventSourceRef.current !== es) return;
        setError("Connection to server lost");
        setStatus("error");
        es.close();
        eventSourceRef.current = null;
      };
    }, 0);
  }, [disconnect]);

  useEffect(() => {
    return disconnect;
  }, [disconnect]);

  return { lines, status, exitCode, error, connect, disconnect };
}
