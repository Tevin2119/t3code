import {
  CLIENT_GUARDED_RPC_SCOPES,
  isServerOwnedThreadLineage,
  WS_METHODS,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { fileThreadTaskOffered } from "./fileThreadTask.logic";

/**
 * Which thread has the "File a task" dialog open. The details panel, the thread menus and the
 * command palette all open it, so the app root renders the dialog once.
 */
export const fileThreadTaskDialogAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("delivery:file-thread-task-dialog"),
);

export function openFileThreadTaskDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(fileThreadTaskDialogAtom, threadRef);
}

/** Whether a thread menu offers filing this thread, read as the menu opens. */
export function readFileThreadTaskOffered(threadRef: ScopedThreadRef): boolean {
  const { environmentId } = threadRef;
  const lineage = readThreadShell(threadRef)?.lineage;
  return fileThreadTaskOffered({
    deliveryEnabled:
      appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId))?.delivery?.enabled ===
      true,
    // A thread not loaded yet is not offered; its menu is read again when it opens.
    serverOwned: lineage === undefined || isServerOwnedThreadLineage(lineage),
    // The scope the filing RPC is guarded by, as its permission atom reads it.
    permitted: readEnvironmentScope(
      environmentId,
      CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.deliveryFileThreadTask],
    ),
  });
}
