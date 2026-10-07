// @effect-diagnostics nodeBuiltinImport:off - the store is a real SQLite database on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import {
  ANTIGRAVITY_MODEL_NOT_RECORDED,
  antigravityRecordsFrom,
  readAntigravityRecords,
} from "./antigravityUsage.ts";

/** A protocol buffer field: a number is a varint, anything else is length-delimited. */
type Value = number | string | Uint8Array | readonly [number, Value][];

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}

function message(fields: readonly [number, Value][]): Uint8Array {
  const bytes: number[] = [];
  for (const [number, value] of fields) {
    if (typeof value === "number") {
      bytes.push(...varint(number * 8), ...varint(value));
      continue;
    }
    const body =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array
          ? value
          : message(value);
    bytes.push(...varint(number * 8 + 2), ...varint(body.length), ...body);
  }
  return Uint8Array.from(bytes);
}

/** The metadata of a step that is a model call, shaped after agy 1.2.16's. */
const callStep = (input: {
  readonly finishedAt: number;
  readonly uncached: number;
  readonly cached?: number;
  readonly output: number;
  readonly thinking?: number;
}) =>
  message([
    [1, [[1, input.finishedAt - 5]]],
    [3, 2],
    [
      8,
      [
        [1, input.finishedAt],
        [2, 250_000_000],
      ],
    ],
    [
      9,
      [
        [1, 1318],
        [2, input.uncached],
        [3, input.output],
        ...(input.cached ? ([[5, input.cached]] as [number, Value][]) : []),
        [6, 24],
        [7, "bot-1"],
        ...(input.thinking ? ([[9, input.thinking]] as [number, Value][]) : []),
        [10, input.output - (input.thinking ?? 0)],
      ],
    ],
  ]);

/** The step a person's message is: no model call, so no usage. */
const userStep = message([
  [1, [[1, 1_791_390_750]]],
  [3, 4],
]);

const executor = (model: string) => message([[10, [[1, [[28, model]]]]]]);
const generation = (served: string) => message([[1, [[19, served]]]]);

describe("Antigravity", () => {
  const conversation = {
    conversationId: "877c5304-b727-40d9-a66c-6372c9fe112d",
    steps: [
      { idx: 0, metadata: userStep },
      {
        idx: 1,
        metadata: callStep({
          finishedAt: 1_791_390_753,
          uncached: 12305,
          output: 437,
          thinking: 319,
        }),
      },
      {
        idx: 3,
        metadata: callStep({
          finishedAt: 1_791_390_770,
          uncached: 4779,
          cached: 12174,
          output: 224,
          thinking: 200,
        }),
      },
    ],
    executors: [executor("gemini-3.8-flash-high")],
    generations: [generation("gemini-3.8-flash-n")],
  };

  it("counts each model call, with its cache and its thinking within the output", () => {
    const records = antigravityRecordsFrom(conversation, "antigravity");
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      provider: "antigravity",
      timestampMs: 1_791_390_770_250,
      model: "gemini-3.8-flash",
      modelProvider: "antigravity",
      modelProviderSource: "harness",
      sessionId: conversation.conversationId,
      reportedCostUsd: null,
      dedupeKey: `antigravity:${conversation.conversationId}:3`,
      totals: {
        uncachedInputTokens: 4779,
        cachedInputTokens: 12174,
        cacheCreationTokens: 0,
        outputTokens: 224,
        reasoningTokens: 200,
      },
    });
  });

  it("names who pays: a key or Agent Platform bills the tokens", () => {
    expect(antigravityRecordsFrom(conversation, "gemini")[0]?.modelProvider).toBe("gemini");
  });

  it("falls back to the model the service named, then to none", () => {
    expect(
      antigravityRecordsFrom({ ...conversation, executors: [] }, "antigravity")[0]?.model,
    ).toBe("gemini-3.8-flash-n");
    expect(
      antigravityRecordsFrom({ ...conversation, executors: [], generations: [] }, "antigravity")[0]
        ?.model,
    ).toBe(ANTIGRAVITY_MODEL_NOT_RECORDED);
  });

  it("reads nothing from bytes that are not a message", () => {
    const broken = { idx: 9, metadata: Uint8Array.from([0x4a, 0x7f, 0x01]) };
    expect(antigravityRecordsFrom({ ...conversation, steps: [broken] }, "antigravity")).toEqual([]);
  });

  it("reads a conversation's database, and says when it cannot", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "antigravity-usage-"));
    try {
      const file = NodePath.join(directory, `${conversation.conversationId}.db`);
      const store = new NodeSqlite.DatabaseSync(file);
      store.exec(
        "create table steps (idx integer primary key, step_type integer, metadata blob);" +
          "create table executor_metadata (idx integer primary key, data blob);" +
          "create table gen_metadata (idx integer primary key, data blob, size integer);",
      );
      for (const step of conversation.steps) {
        store.prepare("insert into steps values (?, 15, ?)").run(step.idx, step.metadata);
      }
      store.prepare("insert into executor_metadata values (0, ?)").run(conversation.executors[0]!);
      store.close();

      const records = readAntigravityRecords(file, conversation.conversationId, "antigravity");
      expect(records?.map((record) => record.totals.outputTokens)).toEqual([437, 224]);
      expect(
        readAntigravityRecords(NodePath.join(directory, "missing.db"), "missing", "antigravity"),
      ).toBeNull();
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
