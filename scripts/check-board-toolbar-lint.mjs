import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const created = [
  "apps/web/src/components/delivery/BoardToolbar.tsx",
  "apps/web/src/components/delivery/BoardToolbar.test.tsx",
  "apps/web/src/components/delivery/BoardEngineNotice.tsx",
  "scripts/check-board-toolbar-lint.mjs",
];
const edited = [
  "apps/web/src/components/delivery/BoardPage.tsx",
  "apps/web/src/components/delivery/BoardPicker.tsx",
  "apps/web/src/components/ui/sheet.tsx",
];

function lint(files) {
  const result = NodeChildProcess.spawnSync(
    "pnpm",
    ["exec", "vp", "lint", "--format", "json", ...files],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  const output = result.stdout;
  const start = output.indexOf("{");
  if (start < 0) throw new Error(result.stderr || output || "Lint produced no diagnostics");
  const report = JSON.parse(output.slice(start));
  if (!Array.isArray(report.diagnostics)) throw new Error("Unexpected lint report");
  if (report.number_of_files !== files.length) throw new Error("Lint skipped requested files");
  if (result.status !== 0 && report.diagnostics.length === 0)
    throw new Error(result.stderr || output);
  return report.diagnostics;
}

function normalized(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics) {
    const key = JSON.stringify([diagnostic.code, diagnostic.severity, diagnostic.message]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

let failed = false;
const temporary = NodeFS.mkdtempSync(NodePath.join(root, ".board-toolbar-lint-"));
try {
  const strict = lint(created);
  if (strict.length) {
    failed = true;
    console.error(JSON.stringify(strict, null, 2));
  }
  for (const file of edited) {
    const baseline = NodeChildProcess.spawnSync("git", ["show", `master:${file}`], {
      cwd: root,
      encoding: "utf8",
    });
    if (baseline.status !== 0) throw new Error(baseline.stderr);
    const copy = NodePath.join(temporary, file);
    NodeFS.mkdirSync(NodePath.dirname(copy), { recursive: true });
    NodeFS.writeFileSync(copy, baseline.stdout);
    // Keep the original file untouched; both versions use the worktree's current lint rules.
    const before = normalized(lint([copy]));
    const after = normalized(lint([file]));
    for (const [diagnostic, count] of after) {
      if (count > (before.get(diagnostic) ?? 0)) {
        failed = true;
        console.error(`${file}: ${diagnostic} (${count - (before.get(diagnostic) ?? 0)} new)`);
      }
    }
  }
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
if (!failed)
  console.log("New toolbar files lint clean; edited files add no findings against master.");
process.exitCode = failed ? 1 : 0;
