import { createContext, useContext } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";

/** A containing workspace can inspect related threads without leaving its own route. */
export const ThreadInspectionContext = createContext<((thread: ScopedThreadRef) => void) | null>(
  null,
);
export const useThreadInspection = () => useContext(ThreadInspectionContext);
