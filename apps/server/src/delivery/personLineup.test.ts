import {
  type DeliveryOrchestrationConfig,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { setPersonLineup } from "./personLineup.ts";

const seat = (name: string) => ({
  seat: name,
  role: name,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-sol" },
});
const LINEUP: DeliveryOrchestrationConfig = { participants: [seat("builder"), seat("reviewer")] };

const services = (engineIntake: string | undefined) => {
  const saved: Array<unknown> = [];
  return {
    saved,
    shellOf: () =>
      Effect.succeed({
        lineage: engineIntake === undefined ? {} : { engineIntake },
      } as unknown as OrchestrationV2ThreadShell),
    delivery: {
      setThreadLineup: (input: unknown) =>
        Effect.sync(() => {
          saved.push(input);
          return { binding: null, pending: null };
        }),
    },
  };
};

it.effect("refuses a person's lineup change on a thread the board owns", () =>
  Effect.gen(function* () {
    const board = services("board-task:work:task-7");
    for (const orchestration of [LINEUP, null]) {
      const refused = yield* setPersonLineup(
        { threadId: ThreadId.make("board-task:work:task-7"), orchestration },
        board,
      ).pipe(Effect.flip);
      assert.equal(refused.reason, "refused");
    }
    assert.lengthOf(board.saved, 0);
  }),
);

it.effect("saves a person's lineup change on their own conversation", () =>
  Effect.gen(function* () {
    const own = services(undefined);
    yield* setPersonLineup({ threadId: ThreadId.make("t1"), orchestration: LINEUP }, own);
    assert.lengthOf(own.saved, 1);
  }),
);
