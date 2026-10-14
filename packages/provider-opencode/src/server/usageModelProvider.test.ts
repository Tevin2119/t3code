import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { openCodeUsageReader } from "./usage.ts";

describe("OpenCode usage (fork)", () => {
  it.effect("keeps the provider OpenCode chose, and reads an instance's own data dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "opencode-instance-" });
      const messages = path.join(root, "storage", "message", "ses_1");
      yield* fileSystem.makeDirectory(messages, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(messages, "msg_1.json"),
        JSON.stringify({
          role: "assistant",
          sessionID: "ses_1",
          modelID: "glm-5.3",
          providerID: "zai-coding-plan",
          time: { created: 1790719302282 },
          tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      );
      if (openCodeUsageReader.kind !== "scan") return assert.fail("OpenCode reads by scan");
      const scans = yield* openCodeUsageReader
        .scan({
          instances: [
            {
              instanceId: ProviderInstanceId.make("opencode_work"),
              config: undefined,
              environment: { OPENCODE_DATA_DIR: root },
              configured: true,
            },
          ],
          settings: DEFAULT_SERVER_SETTINGS,
          windowStartMs: 0,
          retentionCutoffMs: 0,
          awaitRefresh: false,
        })
        .pipe(
          // The host's own default data dir is empty, so only the instance's counts.
          Effect.provideService(HostProcess.Environment, {
            OPENCODE_DATA_DIR: path.join(root, "none"),
          }),
        );
      const records = scans.flatMap((scan) => scan.files ?? []).flatMap((file) => file.records);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.modelProvider, "zai-coding-plan");
      assert.strictEqual(records[0]?.modelProviderSource, "recorded");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
