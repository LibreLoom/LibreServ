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
      clearTimeout(timers.get(id));
      timers.delete(id);
    }
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 420);
  }, []);

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
        if (newToasts.length > maxToasts) {
          const removed = newToasts.shift();
          if (removed && timersRef.current.has(removed.id)) {
            clearTimeout(timersRef.current.get(removed.id));
            timersRef.current.delete(removed.id);
          }
        }
        return newToasts;
      });

      if (toastDuration > 0) {
        const timer = setTimeout(() => {
          dismissToast(id);
        }, toastDuration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [maxToasts, dismissToast]
  );

  const clearToasts = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
    setToasts([]);
  }, []);

  const value = {
    toasts,
    addToast,
    dismissToast,
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
