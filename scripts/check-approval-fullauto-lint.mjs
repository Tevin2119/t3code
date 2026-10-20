import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const created = [
  "scripts/check-approval-fullauto-lint.mjs",
  "apps/web/src/components/delivery/ApprovalControls.tsx",
  "apps/web/src/components/delivery/ApprovalControls.test.tsx",
  "apps/web/src/components/delivery/taskActions.test.tsx",
];
const edited = [
  "apps/web/src/components/delivery/EnginePanel.tsx",
  "apps/web/src/components/delivery/TaskWorkspace.tsx",
  "apps/web/src/components/delivery/taskActions.tsx",
  "apps/web/src/components/sidebar/SidebarChrome.tsx",
  "apps/web/src/lib/delivery.ts",
  "apps/web/src/lib/delivery.test.ts",
  "apps/web/src/lib/deliveryEngineControl.ts",
  "apps/web/src/lib/deliveryEngineControl.test.ts",
  "apps/web/src/state/delivery.ts",
];

// Master 043178d50e fails plain vp lint on four edited files. Each class/hook
// below was checked with git show against that master; counts match its debt.
// Do not lint master copies in a temporary folder: web rules apply only at real
// apps/web paths (temporary copies report 1 finding where real paths report 40).
const masterFindings = [
  [
    "apps/web/src/components/delivery/taskActions.tsx",
    "t3code(no-manual-memo)",
    "error",
    "Drop useCallback: the React Compiler memoizes this file. Write the plain value or function, and use useStableCallback only where a handler must keep one identity across renders.",
    4,
  ],
  [
    "apps/web/src/components/delivery/taskActions.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"max-w-md" is not allowed on <DialogPopup>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/EnginePanel.tsx",
    "t3code(no-manual-memo)",
    "error",
    "Drop useMemo: the React Compiler memoizes this file. Write the plain value or function, and use useStableCallback only where a handler must keep one identity across renders.",
    1,
  ],
  [
    "apps/web/src/components/delivery/EnginePanel.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"max-w-3xl" is not allowed on <DialogPopup>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/EnginePanel.tsx",
    "shadcn(no-arbitrary-values)",
    "warning",
    '"grid-cols-[auto_1fr]" hardcodes an off-token value. Use a theme token or scale value instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "react(exhaustive-effect-dependencies)",
    "error",
    "Found extra effect dependencies",
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-arbitrary-values)",
    "warning",
    '"max-w-[88%]" hardcodes an off-token value. Use a theme token or scale value instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"[@media(min-width:640px)_and_(min-height:600px)]:hidden" is not allowed on <Button>: its contract allows no classes. Put layout classes on a parent element instead.',
    2,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"max-w-[min(20rem,calc(100vw-2rem))]" is not allowed on <PopoverPopup>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-arbitrary-values)",
    "warning",
    '"max-w-[min(20rem,calc(100vw-2rem))]" hardcodes an off-token value. Use a theme token or scale value instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"w-auto" is not allowed on <SelectTrigger>: its contract allows no classes. Put layout classes on a parent element instead.',
    5,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"min-w-0" is not allowed on <SelectTrigger>: its contract allows no classes. Put layout classes on a parent element instead.',
    5,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"self-start" is not allowed on <SelectTrigger>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"self-start" is not allowed on <Button>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"max-w-3xl" is not allowed on <DialogPopup>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-arbitrary-values)",
    "warning",
    '"max-h-[40dvh]" hardcodes an off-token value. Use a theme token or scale value instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-arbitrary-values)",
    "warning",
    '"grid-cols-[auto_minmax(0,1fr)]" hardcodes an off-token value. Use a theme token or scale value instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-arbitrary-values)",
    "warning",
    '"max-h-[45%]" hardcodes an off-token value. Use a theme token or scale value instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"shrink-0" is not allowed on <Button>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"justify-start" is not allowed on <Button>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-arbitrary-values)",
    "warning",
    '"[--control-radius:9999px]" hardcodes an off-token value. Use a theme token or scale value instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"w-full" is not allowed on <Button>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"justify-center" is not allowed on <Button>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "t3code(no-manual-memo)",
    "error",
    "Drop useMemo: the React Compiler memoizes this file. Write the plain value or function, and use useStableCallback only where a handler must keep one identity across renders.",
    4,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"ml-auto" is not allowed on <SelectTrigger>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"w-44" is not allowed on <Input>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"isolate" is not allowed on <SidebarInset>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"h-dvh" is not allowed on <SidebarInset>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"min-h-0" is not allowed on <SidebarInset>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"overflow-hidden" is not allowed on <SidebarInset>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"overscroll-y-none" is not allowed on <SidebarInset>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"hidden" is not allowed on <Badge>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-restyle)",
    "warning",
    '"[@media(min-width:640px)_and_(min-height:600px)]:inline-flex" is not allowed on <Badge>: its contract allows no classes. Put layout classes on a parent element instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-arbitrary-values)",
    "warning",
    '"grid-rows-[minmax(0,1fr)]" hardcodes an off-token value. Use a theme token or scale value instead.',
    1,
  ],
  [
    "apps/web/src/components/delivery/TaskWorkspace.tsx",
    "shadcn(no-arbitrary-values)",
    "warning",
    '"xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)_19rem]" hardcodes an off-token value. Use a theme token or scale value instead.',
    1,
  ],
  [
    "apps/web/src/state/delivery.ts",
    "t3code(no-manual-memo)",
    "error",
    "Drop useMemo: the React Compiler memoizes this file. Write the plain value or function, and use useStableCallback only where a handler must keep one identity across renders.",
    3,
  ],
  [
    "apps/web/src/state/delivery.ts",
    "t3code(no-manual-memo)",
    "error",
    "Drop useCallback: the React Compiler memoizes this file. Write the plain value or function, and use useStableCallback only where a handler must keep one identity across renders.",
    2,
  ],
];
const baseline = new Map(
  masterFindings.map(([file, code, severity, message, count]) => [
    JSON.stringify([file, code, severity, message]),
    count,
  ]),
);

function lint(files) {
  const result = NodeChildProcess.spawnSync(
    "pnpm",
    ["exec", "vp", "lint", "--format", "json", ...files],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
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

let failed = false;
const strict = lint(created);
if (strict.length) {
  failed = true;
  console.error(JSON.stringify(strict, null, 2));
}
const counts = new Map();
for (const diagnostic of lint(edited)) {
  const key = JSON.stringify([
    diagnostic.filename,
    diagnostic.code,
    diagnostic.severity,
    diagnostic.message,
  ]);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
for (const [key, count] of counts) {
  const allowed = baseline.get(key) ?? 0;
  if (count > allowed) {
    failed = true;
    console.error(`${key}: ${count - allowed} new finding(s)`);
  }
}
if (!failed)
  console.log(
    "New approval/full-auto files lint clean; edited files add no findings against master 043178d50e.",
  );
process.exitCode = failed ? 1 : 0;
