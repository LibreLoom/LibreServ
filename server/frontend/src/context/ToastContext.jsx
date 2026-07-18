/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, useRef } from "react";
import PropTypes from "prop-types";

const ToastContext = createContext(null);

const DEFAULT_DURATIONS = {
  success: 3000,
  error: 5000,
  info: 3000,
};

let toastIdCounter = 0;

export function ToastProvider({ children, maxToasts = 5 }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());

  const dismissToast = useCallback((id) => {
    const timers = timersRef.current;
    if (timers.has(id)) {
      clearTimeout(timers.get(id).timer);
      timers.delete(id);
    }
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 420);
  }, []);

  const pauseToast = useCallback((id) => {
    const timers = timersRef.current;
    if (!timers.has(id)) return;

    const timerInfo = timers.get(id);
    if (timerInfo.timer) {
      clearTimeout(timerInfo.timer);
      const elapsed = Date.now() - timerInfo.startedAt;
      const remaining = Math.max(0, timerInfo.remaining - elapsed);
      timers.set(id, { timer: null, remaining, startedAt: null });
    }
  }, []);

  const resumeToast = useCallback((id) => {
    const timers = timersRef.current;
    if (!timers.has(id)) return;

    const timerInfo = timers.get(id);
    if (!timerInfo.timer && timerInfo.remaining > 0) {
      const timer = setTimeout(() => {
        dismissToast(id);
      }, timerInfo.remaining);
      timers.set(id, { timer, remaining: timerInfo.remaining, startedAt: Date.now() });
    }
  }, [dismissToast]);

  const addToast = useCallback(
    ({ type = "info", message, description, duration }) => {
      const id = ++toastIdCounter;
      const toastDuration = duration ?? DEFAULT_DURATIONS[type] ?? 3000;

      const toast = {
        id,
        type,
        message,
        description,
        createdAt: Date.now(),
        duration: toastDuration,
      };

      setToasts((prev) => {
        const newToasts = [...prev, toast];
        const active = newToasts.filter((t) => !t.exiting);
        if (active.length > maxToasts) {
          // Evict the oldest active toast with an exit animation, not a hard cut.
          const victim = active[0];
          const idx = newToasts.findIndex((t) => t.id === victim.id);
          if (idx !== -1) {
            newToasts[idx] = { ...victim, exiting: true };
            if (timersRef.current.has(victim.id)) {
              clearTimeout(timersRef.current.get(victim.id).timer);
              timersRef.current.delete(victim.id);
            }
            setTimeout(() => {
              setToasts((cur) => cur.filter((t) => t.id !== victim.id));
            }, 420);
          }
        }
        return newToasts;
      });

      if (toastDuration > 0) {
        const timer = setTimeout(() => {
          dismissToast(id);
        }, toastDuration);
        timersRef.current.set(id, { timer, remaining: toastDuration, startedAt: Date.now() });
      }

      return id;
    },
    [maxToasts, dismissToast]
  );

  const clearToasts = useCallback(() => {
    timersRef.current.forEach((timerInfo) => clearTimeout(timerInfo.timer));
    timersRef.current.clear();
    setToasts([]);
  }, []);

  const value = {
    toasts,
    addToast,
    dismissToast,
    pauseToast,
    resumeToast,
    clearToasts,
  };

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

ToastProvider.propTypes = {
  children: PropTypes.node,
  maxToasts: PropTypes.number,
};

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export default ToastContext;
