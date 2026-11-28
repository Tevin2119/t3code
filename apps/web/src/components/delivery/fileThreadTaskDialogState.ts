import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

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
