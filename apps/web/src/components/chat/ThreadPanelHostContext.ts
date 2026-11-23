import { createContext, useContext } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * A containing workspace whose own thread keeps the panels while it shows a related thread in its
 * place: that thread's view shows the host thread's right panel and details panel, not its own.
 */
export const ThreadPanelHostContext = createContext<ScopedThreadRef | null>(null);
export const useThreadPanelHost = () => useContext(ThreadPanelHostContext);
