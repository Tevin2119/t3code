import { type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { refuseServerOwnedTeam } from "./serverOwnedTeam.ts";

const shellWith = (engineIntake: string | undefined) => () =>
  Effect.succeed({
    lineage: engineIntake === undefined ? {} : { engineIntake },
  } as unknown as OrchestrationV2ThreadShell);

it.effect("refuses a person's team change on a thread the server owns", () =>
  Effect.gen(function* () {
    const refused = yield* refuseServerOwnedTeam(
      ThreadId.make("limited-lead:run-1"),
      shellWith("board-task:work:task-7"),
    ).pipe(Effect.flip);
    assert.equal(refused.reason, "refused");
  }),
);

it.effect("lets a person change the team of their own conversation, or one with no shell", () =>
  Effect.gen(function* () {
    yield* refuseServerOwnedTeam(ThreadId.make("t1"), shellWith(undefined));
    // With no shell the delivery service decides, by the thread's id.
    yield* refuseServerOwnedTeam(ThreadId.make("t2"), () => Effect.succeed(null));
  }),
);
