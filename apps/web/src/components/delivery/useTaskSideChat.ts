import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { useQuietThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useSideChat } from "../chat/useSideChat";
import { toastManager } from "../ui/toast";

/**
 * "Discuss in a thread": T3's own side chat of the task's thread, offered where the thread view
 * would offer one. It opens in the task thread's right panel and is listed among its side chats.
 * What is said there stays in the side chat; it does not reach the task or the engine.
 */
export function useTaskSideChat(thread: ScopedThreadRef | null): (() => void) | null {
  const gt = useGT();
  const environmentId = thread?.environmentId ?? null;
  const environment = useEnvironment(environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const shell = useQuietThreadShell(thread);
  const offered =
    shell !== null &&
    canOperate &&
    shell.lineage.sideChat !== true &&
    shell.lineage.relationshipToParent !== "subagent" &&
    (shell.delegatedFrom ?? null) === null &&
    environment?.serverConfig?.environment.capabilities.sideChats === true;
  const sideChat = useSideChat({
    threadRef: offered ? thread : null,
    // The side chat keeps the task thread's model and mode, as one started in that thread would.
    readSettings: () => ({
      runtimeMode: shell?.runtimeMode ?? "full-access",
      modelSelection: undefined,
    }),
    onError: (description) =>
      toastManager.add({ type: "error", title: gt("Could not start a side chat"), description }),
  });
  return sideChat.available ? () => void sideChat.open() : null;
}
