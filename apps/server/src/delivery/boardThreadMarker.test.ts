// @effect-diagnostics nodeBuiltinImport:off - reads the source tree synchronously, once.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { boardTaskThreadMarker } from "./boardThreadMarker.ts";

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
];

it("only the engine intake reads the marker's value; every other reader asks whether it is set", () => {
  const valueReads = linesNaming(/engineIntake|engine_intake/).filter(
    ({ line }) => !NOT_A_VALUE_READ.some((allowed) => allowed.test(line)),
  );
  assert.deepEqual(valueReads, [
    {
      file: "apps/server/src/delivery/NativeIntake.ts",
      line: "if (projection.thread.lineage.engineIntake !== admissionId)",
    },
  ]);
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
