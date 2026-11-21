import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { msg, useGT } from "gt-react";
import { WrenchIcon } from "lucide-react";
import { useState } from "react";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { m } from "../../i18n/messages";
import {
  buildProviderProblemPrompt,
  type ProviderProblem,
  resolveProviderFixModelSelection,
} from "../../lib/providerProblem";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readProject } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Opens a new thread in the project with the problem in its composer, on the default
 * provider, so an agent can be asked to fix it. Hidden where threads cannot run.
 */
export function ProviderProblemFixButton(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly problem: ProviderProblem;
}) {
  const gt = useGT();
  const newThread = useNewThreadHandler();
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const [opening, setOpening] = useState(false);
  const { environmentId, projectId, problem } = props;
  if (projectId === null || !canOperate) return null;

  const open = async () => {
    setOpening(true);
    const projectRef = scopeProjectRef(environmentId, projectId);
    const opened = await newThread(projectRef, {
      prompt: buildProviderProblemPrompt(problem),
      fresh: true,
    }).catch(() => null);
    setOpening(false);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: m(msg("Could not open a thread")),
        description: m(msg("Try again from the project, or open a thread first.")),
      });
      return;
    }
    const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
    const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
    const selection = resolveProviderFixModelSelection({
      defaultSelection:
        resolveProjectSettings(settings, projectId, readProject(projectRef)).settings
          .defaultModelSelection ?? null,
      providers: config?.providers ?? [],
      settings,
      projectId,
      broken: problem.instanceId,
    });
    if (selection) {
      useComposerDraftStore
        .getState()
        .setModelSelection(opened.draftId, selection, { replaceOptions: true });
    }
    toastManager.add({
      type: "success",
      title: m(msg("Opened a thread to fix it")),
      description: m(msg("The problem is in the composer. Read it over, then send.")),
    });
  };

  return (
    <Button
      aria-label={gt("Open a thread to fix {provider}", { provider: problem.provider })}
      disabled={opening}
      onClick={() => void open()}
      size="xs"
      variant="outline"
    >
      <WrenchIcon />
      {gt("Fix", { $context: "verb, opens a thread to fix a provider problem" })}
    </Button>
  );
}
