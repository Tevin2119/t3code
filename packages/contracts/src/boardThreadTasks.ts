import * as Schema from "effect/Schema";

import { ThreadId, TurnItemId } from "./baseSchemas.ts";

export const BoardTaskBoardId = Schema.String.check(Schema.isPattern(/^[\w-]{1,100}$/));

export function isReservedBoardTaskBoard(board: string): boolean {
  return ["unsorted", "all", "pilot", "qualification"].includes(board);
}

const NonBlank = Schema.String.check(Schema.isNonEmpty(), Schema.isPattern(/\S/));

export const BoardTaskDraft = Schema.Struct({
  board: BoardTaskBoardId,
  title: NonBlank.check(Schema.isMaxLength(120)),
  body: NonBlank.check(Schema.isMaxLength(20_000)),
  context: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8_000))),
});
export type BoardTaskDraft = typeof BoardTaskDraft.Type;

const FiledTask = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  board: Schema.NullOr(Schema.String),
  team: Schema.String,
  state: Schema.String,
  origin: Schema.String,
});

export const BoardTaskFiling = Schema.Struct({
  created: Schema.Boolean,
  task: FiledTask,
});

export const BoardTaskOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("filed"), filing: BoardTaskFiling }),
  Schema.Struct({ status: Schema.Literals(["declined", "cancelled"]) }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
]);
export type BoardTaskOutcome = typeof BoardTaskOutcome.Type;

export const BoardTaskResolution = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  BoardTaskOutcome,
]);
export type BoardTaskResolution = typeof BoardTaskResolution.Type;

export const BoardTaskAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Literals(["file", "decline"]),
});
export type BoardTaskAnswerInput = typeof BoardTaskAnswerInput.Type;
