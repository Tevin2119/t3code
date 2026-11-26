// @effect-diagnostics nodeBuiltinImport:off - reads the source tree synchronously, once.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  BOARD_TASK_MARKER_LIKE,
  boardTaskOf,
  boardTaskOfMarker,
  boardTaskThreadCommandId,
  boardTaskThreadId,
  boardTaskThreadMarker,
} from "./boardThreadMarker.ts";

const TASK = boardTaskOf("board-1", "task-7")!;

// A board task's thread reuses `lineage.engineIntake` as its marker, with a value of its own. That
// is safe only while every reader but the engine intake asks whether the field is set, never what
// it holds: a reader of the value would treat a board thread as an intake, or find a thread from a
// task. These tests read the source, so a new reader has to be named here on purpose.

const REPO = NodePath.resolve(import.meta.dirname, "../../../..");
const SOURCE_ROOTS = [
  "apps/server/src",
  "apps/web/src",
  "apps/mobile/src",
  "apps/desktop/src",
  "packages/contracts/src",
  "packages/client-runtime/src",
  "packages/shared/src",
];

function sourceFiles(directory: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(NodePath.join(REPO, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    },
  );
}

const linesNaming = (pattern: RegExp) =>
  SOURCE_ROOTS.flatMap(sourceFiles).flatMap((file) =>
    NodeFS.readFileSync(NodePath.join(REPO, file), "utf8")
      .split("\n")
      .filter((line) => pattern.test(line))
      .map((line) => ({ file, line: line.trim() })),
  );

// Every way the field may appear without its value deciding anything.
const NOT_A_VALUE_READ: ReadonlyArray<RegExp> = [
  // The schema and the row types that declare it.
  /^engineIntake: Schema\.optional\(TrimmedNonEmptyString\),$/,
  /^readonly engine_intake\??: string \| null;$/,
  /^lineage: Pick<OrchestrationV2AppThreadLineage, "engineIntake">,$/,
  // Presence: `isServerOwnedThreadLineage` and the SQL exclusions.
  /^\): boolean => lineage\.engineIntake !== undefined;$/,
  /^AND json_extract\((t|threads)\.payload_json, '\$\.lineage\.engineIntake'\) IS NULL`?$/,
  // Carried from a command or a row into the lineage, or selected to be carried, unread.
  /^\.\.\.\(command\.engineIntake === undefined \? \{\} : \{ engineIntake: command\.engineIntake \}\),$/,
  /^\.\.\.\(row\.engine_intake == null \? \{\} : \{ engineIntake: row\.engine_intake \}\),$/,
  /^\$\{indexedField\("\$\.lineage\.engineIntake"\)\} AS engine_intake,$/,
  /^json_extract\(t\.payload_json, '\$\.lineage\.engineIntake'\) AS engine_intake,$/,
  /^CASE WHEN json_valid\(payload_json\) THEN json_extract\(payload_json, '\$\.lineage\.engineIntake'\) END,$/,
  // Taken off a client's create command, so only the server stamps it.
  /^engineIntake: _engineIntake,$/,
  // The engine intake stamping its own admission.
  /^engineIntake: admissionId,$/,
  // A board task's thread stamped at its creation, by the marker module's own spelling.
  /^engineIntake: boardTaskThreadMarker\(task\),$/,
];

// The board task readers. Each hands the value to the marker module, thread to task only, and
// none builds a marker to find a thread: a task's thread is the engine's `boardThread`.
const BOARD_TASK_READS = [
  // The threads this server made for board tasks, selected on the marker's own prefix.
  {
    file: "apps/server/src/delivery/boardThreadRows.ts",
    line: "json_extract(t.payload_json, '$.lineage.engineIntake') AS marker",
  },
  {
    file: "apps/server/src/delivery/boardThreadRows.ts",
    line: "AND json_extract(t.payload_json, '$.lineage.engineIntake') LIKE ${BOARD_TASK_MARKER_LIKE}",
  },
  // The thread just created is the task's own, before the engine is told of it.
  {
    file: "apps/server/src/delivery/BoardTaskThreads.ts",
    line: "const stamped = boardTaskOfMarker(created.thread.lineage.engineIntake);",
  },
  // A board task's conversation starts no team round while the engine does the task's work.
  {
    file: "apps/server/src/delivery/NativeTeamChat.ts",
    line: "if (boardTaskOfMarker(parent.thread.lineage.engineIntake) !== null)",
  },
  {
    file: "apps/server/src/delivery/SeatHandoffs.ts",
    line: "const task = boardTaskOfMarker(parent?.lineage.engineIntake);",
  },
  {
    file: "apps/server/src/delivery/SeatHandoffs.ts",
    line: "const task = boardTaskOfMarker(lead?.lineage.engineIntake);",
  },
];

it("only the engine intake and the named board task readers read the marker's value", () => {
  const valueReads = linesNaming(/engineIntake|engine_intake/).filter(
    ({ line }) => !NOT_A_VALUE_READ.some((allowed) => allowed.test(line)),
  );
  const byPlace = (a: { file: string; line: string }, b: { file: string; line: string }) =>
    `${a.file}\n${a.line}`.localeCompare(`${b.file}\n${b.line}`);
  assert.deepEqual(
    valueReads.toSorted(byPlace),
    [
      {
        file: "apps/server/src/delivery/NativeIntake.ts",
        line: "if (projection.thread.lineage.engineIntake !== admissionId)",
      },
      ...BOARD_TASK_READS,
    ].toSorted(byPlace),
  );
});

it("nothing but the marker module knows what a board task's marker looks like", () => {
  assert.equal(boardTaskThreadMarker(TASK), "board-task:board-1:task-7");
  assert.deepEqual(
    [...new Set(linesNaming(/board-task:/).map(({ file }) => file))],
    ["apps/server/src/delivery/boardThreadMarker.ts"],
  );
});

it("refuses an id the marker cannot carry at write, so no two tasks share a marker", () => {
  for (const [board, id] of [
    // A colon in a task id, the engine's own separator in neither id.
    ["a", "b:c"],
    ["a:b", "c"],
    ["a", ""],
    ["", "b"],
    ["a", "b c"],
    ["a b", "c"],
    ["a", "b/c"],
    ["a", "b%3Ac"],
  ] as const) {
    assert.isNull(boardTaskOf(board, id), `${board} / ${id}`);
  }
  // What the engine writes today passes, and the marker keeps the spelling already stamped.
  const task = boardTaskOf("delivery-engine_tasks.and/board", "t_7-a");
  assert.isNotNull(task);
  assert.equal(boardTaskThreadMarker(task!), "board-task:delivery-engine_tasks.and/board:t_7-a");
  assert.equal(boardTaskThreadId(task!), boardTaskThreadMarker(task!));
  assert.equal(boardTaskThreadCommandId(task!), `${boardTaskThreadMarker(task!)}:thread`);
});

it("reads the task back out of a marker, and ignores every malformed one", () => {
  assert.deepEqual(boardTaskOfMarker(boardTaskThreadMarker(TASK)), TASK);
  const prefix = BOARD_TASK_MARKER_LIKE.slice(0, -1);
  for (const value of [
    null,
    undefined,
    "",
    // An engine intake's admission, and another prefix.
    `intake-${"a".repeat(64)}:0`,
    "board-tasks:a:b",
    "task:a:b",
    // An empty id, and no task id at all.
    prefix,
    `${prefix}only-a-board`,
    `${prefix}:task`,
    `${prefix}board:`,
    // A colon in the task id reads as a third part, never as board `a` with task `b:c`.
    `${prefix}a:b:c`,
    `${prefix}a:b c`,
  ]) {
    assert.equal(boardTaskOfMarker(value), null, String(value));
  }
});
