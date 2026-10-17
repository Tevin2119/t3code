import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const tests = [
  "apps/mobile/src/features/usage/usageProviders.test.ts",
  "apps/web/src/components/ChatView.logic.test.ts",
  "apps/mobile/src/lib/deliveryModelOptions.test.ts",
  "apps/mobile/src/lib/modelOptions.test.ts",
  "apps/mobile/src/features/threads/thread-settings-sheet-state.test.ts",
  "apps/web/src/lib/deliveryComposerSelection.test.tsx",
  "packages/client-runtime/src/deliveryModelLock.test.ts",
  "packages/client-runtime/src/state/deliveryModelBinding.test.ts",
];
const lint = [
  "apps/mobile/src/features/usage/usageProviders.ts",
  "apps/mobile/src/features/usage/usageProviders.test.ts",
  "apps/mobile/src/features/threads/ThreadComposer.tsx",
  "apps/mobile/src/features/threads/ThreadSettingsRows.shared.tsx",
  "apps/mobile/src/features/threads/ThreadSettingsSheet.tsx",
  "apps/mobile/src/features/threads/thread-settings-sheet-state.ts",
  "apps/mobile/src/lib/modelOptions.ts",
  "apps/web/src/components/ChatView.logic.test.ts",
  "apps/web/src/components/ChatView.logic.ts",
  "apps/web/src/components/ChatView.tsx",
  "apps/web/src/components/chat/ChatComposer.tsx",
  "apps/web/src/components/chat/ModelPickerContent.tsx",
  "apps/web/src/components/chat/ModelPickerSidebar.tsx",
  "apps/web/src/components/chat/ProviderModelPicker.tsx",
  "packages/client-runtime/src/state/delivery.ts",
  "apps/mobile/src/lib/deliveryModelOptions.test.ts",
  "apps/mobile/src/state/delivery.ts",
  "apps/web/src/lib/deliveryComposerSelection.test.tsx",
  "apps/web/src/lib/deliveryComposerSelection.ts",
  "apps/web/src/lib/deliveryModelPicker.ts",
  "packages/client-runtime/src/deliveryModelLock.test.ts",
  "packages/client-runtime/src/deliveryModelLock.ts",
  "packages/client-runtime/src/state/deliveryModelBinding.test.ts",
  "scripts/check-delivery-model-lock.mjs",
];
function run(args, cwd = root) {
  const result = NodeChildProcess.spawnSync("pnpm", ["exec", ...args], { cwd, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}
const mode = process.argv[2];
let status = 0;
if (mode === "tests") {
  status = run(["vp", "test", "run", ...tests]);
} else if (mode === "lint") {
  status = run(["vp", "lint", ...lint]);
} else if (mode === "types") {
  for (const directory of ["apps/web", "apps/mobile", "packages/client-runtime"]) {
    const result = run(
      ["tsc", "--noEmit"],
      NodeURL.fileURLToPath(new URL(`../${directory}/`, import.meta.url)),
    );
    if (result !== 0) status = result;
  }
} else {
  console.error("Expected mode: tests, lint, or types.");
  status = 1;
}
process.exitCode = status;
