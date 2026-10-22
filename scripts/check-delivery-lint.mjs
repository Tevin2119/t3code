import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
function git(args) {
  return NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
function lint(files, cwd = root) {
  console.log(`Linting: ${files.join(", ")}`);
  const result = NodeChildProcess.spawnSync(
    "pnpm",
    ["exec", "vp", "lint", "--format", "json", ...files],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  const start = result.stdout.indexOf("{");
  if (start < 0) throw new Error(result.stderr + result.stdout || "No lint report");
  const report = JSON.parse(result.stdout.slice(start));
  if (
    !Array.isArray(report.diagnostics) ||
    !Number.isInteger(report.number_of_files) ||
    report.number_of_files < files.length
  )
    throw new Error("Lint skipped requested files or returned an invalid report");
  if (result.status !== 0 && report.diagnostics.length === 0)
    throw new Error(result.stderr || result.stdout);
  return report.diagnostics;
}
function line(diagnostic) {
  const value = diagnostic.labels?.[0]?.span?.line;
  if (!Number.isInteger(value)) throw new Error("Lint diagnostic has no line");
  return value;
}
function masterLine(file, candidateLine) {
  const diff = git(["diff", "--no-ext-diff", "--unified=0", "master", "--", file]);
  let offset = 0;
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] ?? 1);
    const newStart = Number(match[3]);
    const newCount = Number(match[4] ?? 1);
    if (candidateLine < newStart || (newCount === 0 && candidateLine === newStart)) break;
    if (newCount > 0 && candidateLine < newStart + newCount) return null;
    offset = oldStart + Math.max(0, oldCount - 1) - newStart - Math.max(0, newCount - 1);
  }
  return candidateLine + offset;
}

let temporary;
try {
  git(["rev-parse", "--verify", "master"]);
  const changes = git(["diff", "master", "--name-status", "--", "apps/web", "scripts"])
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((row) => {
      const [status, ...names] = row.split("\t");
      return status === "D" ? [] : [names.at(-1)];
    });
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", "apps/web", "scripts"])
    .trim()
    .split("\n")
    .filter(Boolean);
  const files = [...new Set([...changes, ...untracked])].filter((file) =>
    /\.(?:[cm]?[jt]sx?)$/.test(file),
  );
  if (!files.length) throw new Error("No changed lintable files found");
  const masterFiles = new Set(
    git(["ls-tree", "-r", "--name-only", "master", "--", "apps/web", "scripts"]).trim().split("\n"),
  );
  const edited = files.filter((file) => masterFiles.has(file));
  temporary = NodeFS.mkdtempSync(NodePath.join(root, ".delivery-lint-"));
  NodeFS.writeFileSync(
    NodePath.join(temporary, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  NodeFS.symlinkSync(
    NodePath.join(root, "oxlint-plugin-t3code"),
    NodePath.join(temporary, "oxlint-plugin-t3code"),
  );
  // Run copies from their own root so apps/web glob overrides apply exactly as in the candidate.
  NodeFS.writeFileSync(
    NodePath.join(temporary, "vite.config.ts"),
    'export { default } from "../vite.config";\n',
  );
  for (const file of edited) {
    const copy = NodePath.join(temporary, file);
    NodeFS.mkdirSync(NodePath.dirname(copy), { recursive: true });
    NodeFS.writeFileSync(copy, git(["show", `master:${file}`]));
  }
  for (const file of [
    "apps/web/tsconfig.json",
    "apps/web/package.json",
    "apps/web/components.json",
    "tsconfig.base.json",
  ]) {
    const copy = NodePath.join(temporary, file);
    NodeFS.mkdirSync(NodePath.dirname(copy), { recursive: true });
    NodeFS.copyFileSync(NodePath.join(root, file), copy);
  }
  NodeFS.symlinkSync(
    NodePath.join(root, "apps/web/src/components/ui"),
    NodePath.join(temporary, "apps/web/src/components/ui"),
  );
  const before = edited.length ? lint(edited, temporary) : [];
  const baseline = new Set(
    before.map((finding) =>
      JSON.stringify([
        NodePath.relative(temporary, NodePath.resolve(temporary, finding.filename)),
        line(finding),
        finding.code,
        finding.severity,
      ]),
    ),
  );
  let failed = false;
  for (const finding of lint(files)) {
    const file = NodePath.relative(root, NodePath.resolve(root, finding.filename));
    const mapped = masterFiles.has(file) ? masterLine(file, line(finding)) : null;
    if (
      mapped !== null &&
      baseline.has(JSON.stringify([file, mapped, finding.code, finding.severity]))
    )
      continue;
    failed = true;
    console.error(`${file}:${line(finding)} ${finding.severity} ${finding.code}`);
  }
  process.exitCode = failed ? 1 : 0;
  if (!failed) console.log("No new lint findings against master.");
} finally {
  if (temporary) NodeFS.rmSync(temporary, { recursive: true, force: true });
}
