// @effect-diagnostics nodeBuiltinImport:off - reads the source tree synchronously, once.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import {
  BOARD_TASK_MARKER_LIKE,
  boardTaskOfMarker,
  boardTaskThreadCommandId,
  boardTaskThreadId,
  boardTaskThreadMarker,
} from "./boardThreadMarker.ts";

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
  assert.equal(
    boardTaskThreadMarker({ board: "board-1", id: "task-7" }),
    "board-task:board-1:task-7",
  );
  assert.deepEqual(
    [...new Set(linesNaming(/board-task:/).map(({ file }) => file))],
    ["apps/server/src/delivery/boardThreadMarker.ts"],
  );
});

it("keeps a colon in a board or task id from making two tasks one marker", () => {
  const pairs = [
    [
      { board: "a:b", id: "c" },
      { board: "a", id: "b:c" },
    ],
    [
      { board: "a%3Ab", id: "c" },
      { board: "a:b", id: "c" },
    ],
    [
      { board: "a", id: "b" },
      { board: "a:", id: "b" },
    ],
  ] as const;
  for (const [left, right] of pairs) {
    assert.notEqual(boardTaskThreadMarker(left), boardTaskThreadMarker(right));
    assert.notEqual(boardTaskThreadCommandId(left), boardTaskThreadCommandId(right));
    assert.notEqual(boardTaskThreadId(left), boardTaskThreadId(right));
  }
});

it("reads the task back out of a marker, and nothing out of any other value", () => {
  for (const task of [
    { board: "board-1", id: "task-7" },
    { board: "a:b", id: "c" },
    { board: "a", id: "b:c" },
    { board: "with/slash and space", id: "100%" },
  ]) {
    assert.deepEqual(boardTaskOfMarker(boardTaskThreadMarker(task)), task);
  }
  for (const value of [
    null,
    undefined,
    "",
    // An engine intake's admission.
    `intake-${"a".repeat(64)}:0`,
    BOARD_TASK_MARKER_LIKE,
    `${BOARD_TASK_MARKER_LIKE.slice(0, -1)}only-a-board`,
    `${BOARD_TASK_MARKER_LIKE.slice(0, -1)}a:b:c`,
    `${BOARD_TASK_MARKER_LIKE.slice(0, -1)}:task`,
    // Not the spelling the grammar writes, and a broken escape.
    `${BOARD_TASK_MARKER_LIKE.slice(0, -1)}%61:b`,
    `${BOARD_TASK_MARKER_LIKE.slice(0, -1)}%zz:b`,
  ]) {
    assert.equal(boardTaskOfMarker(value), null, String(value));
  }
});
