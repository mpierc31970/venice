import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";

const Ctx = createContext(null);

/** App-wide state: the Venice balance and toasts. Per-batch state lives in Batch.jsx. */
export function StudioProvider({ children }) {
  const [billing, setBilling] = useState(null);
  const [toasts, setToasts] = useState([]);

  const refreshBilling = useCallback(async () => {
    try { setBilling(await api.get("/api/billing")); } catch (e) { console.warn("billing", e.message); }
  }, []);
  useEffect(() => { refreshBilling(); const t = setInterval(refreshBilling, 60_000); return () => clearInterval(t); }, [refreshBilling]);

  const idRef = useRef(0);
  const toast = useCallback((msg, kind = "info", ms = 5000) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);

  const value = useMemo(() => ({ billing, refreshBilling, toast, toasts }), [billing, refreshBilling, toast, toasts]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useStudio = () => useContext(Ctx);
