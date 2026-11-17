import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";
import { parseTask, type DeliveryCard } from "../../lib/delivery";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { deliveryEnvironment } from "../../state/delivery";
import { useDeliveryReplyDrafts } from "../../state/deliveryReplyDrafts";
import { questionSummaryTasks, waitingQuestionKeys } from "./ThreadTaskQuestions.logic";

const questionRecords = Atom.family((key: string) => {
  const [environmentId, taskIds] = JSON.parse(key) as [EnvironmentId, string[]];
  const atoms = taskIds.map((id) =>
    deliveryEnvironment.read({ environmentId, input: { path: `/api/tasks/${id}` } }),
  );
  return Atom.make((get) =>
    atoms.map((atom) => parseTask(AsyncResult.getOrElse(get(atom), () => null)?.body)),
  );
});

export function useThreadTaskQuestionSummary(
  environmentId: EnvironmentId,
  tasks: ReadonlyArray<DeliveryCard>,
) {
  const drafts = useDeliveryReplyDrafts((state) => state.drafts);
  const pending = useDeliveryReplyDrafts((state) => state.pending);
  const active = questionSummaryTasks(environmentId, tasks, drafts, pending);
  const summaryTaskIds = active.map((task) => task.id);
  const records = useAtomValue(questionRecords(JSON.stringify([environmentId, summaryTaskIds])));
  const summary = JSON.stringify(
    active.map((task) => [
      task.id,
      task.updated,
      task.questions,
      task.unanswered,
      task.state,
      task.revision,
      task.run?.state,
    ]),
  );
  const previous = useRef(new Map<string, string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh bounded engine histories only when the already-polled task list changes their summaries.
  useEffect(() => {
    const versions = JSON.parse(summary) as Array<[string, ...unknown[]]>;
    const next = new Map<string, string>();
    for (const [id, ...version] of versions) {
      const key = JSON.stringify([environmentId, id]);
      const value = JSON.stringify(version);
      if (previous.current.has(key) && previous.current.get(key) !== value) {
        appAtomRegistry.refresh(
          deliveryEnvironment.read({ environmentId, input: { path: `/api/tasks/${id}` } }),
        );
      }
      next.set(key, value);
    }
    previous.current = next;
  }, [environmentId, summary]);
  const byId = new Map(records.flatMap((task) => (task ? [[task.id, task] as const] : [])));
  const waitingKeys: string[] = [];
  let waitingCount = 0;
  for (const card of tasks) {
    const task = byId.get(card.id);
    if (task) {
      const keys = waitingQuestionKeys(environmentId, task, drafts, pending);
      waitingKeys.push(...keys);
      waitingCount += keys.length;
    } else {
      const taskKey = JSON.stringify([environmentId, card.id]);
      const prefix = `${taskKey.slice(0, -1)},`;
      const sending = Object.keys(pending).filter((key) => key.startsWith(prefix) && pending[key]);
      const unsentDrafts = Object.keys(drafts).filter(
        (key) =>
          key.startsWith(prefix) &&
          !pending[key] &&
          (drafts[key]!.text.length > 0 || drafts[key]!.option !== null || drafts[key]!.uncertain),
      );
      const count = Math.max(0, card.questions - sending.length, unsentDrafts.length);
      if (count > 0) waitingKeys.push(taskKey);
      waitingCount += count;
    }
  }
  const loadedTaskKeys = [...byId.keys()].map((id) => JSON.stringify([environmentId, id]));
  return { waitingKeys, waitingCount, loadedTaskKeys, summaryTaskIds };
}
