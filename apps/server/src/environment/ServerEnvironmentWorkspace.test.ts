import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import {
  resolveServerEnvironmentWorkspace,
  WorkspaceBindingError,
} from "./ServerEnvironmentWorkspace.ts";

const environment = {
  T3_WORKSPACE_MACHINE_ID: "mac",
  T3_WORKSPACE_MACHINE_LABEL: "MacBook",
  T3_WORKSPACE_PROFILE_ID: "main",
  T3_WORKSPACE_PROFILE_LABEL: "Main",
};

const isWorkspaceBindingError = Schema.is(WorkspaceBindingError);

it.layer(NodeServices.layer)("account-profile workspace binding", (it) => {
  it.effect(
    "pins identities, permits display-name changes and refuses reusing another profile's home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped();
        const read = (env: NodeJS.ProcessEnv) =>
          resolveServerEnvironmentWorkspace().pipe(
            Effect.provideService(HostProcessEnvironment, env),
            Effect.provide(ServerConfig.layerTest(process.cwd(), home)),
          );
        expect(yield* read({})).toBeUndefined();
        expect((yield* read(environment))?.profileId).toBe("main");
        expect(
          (yield* read({ ...environment, T3_WORKSPACE_PROFILE_LABEL: "Personal" }))?.profileLabel,
        ).toBe("Personal");
        const mismatch = yield* read({ ...environment, T3_WORKSPACE_PROFILE_ID: "pm" }).pipe(
          Effect.flip,
        );
        expect(isWorkspaceBindingError(mismatch)).toBe(true);
        expect(mismatch.message).toContain("another machine or account profile");
        const unscoped = yield* read({}).pipe(Effect.flip);
        expect(unscoped.message).toContain("profile launcher");
        const moved = yield* read({ ...environment, T3_WORKSPACE_MACHINE_ID: "other" }).pipe(
          Effect.flip,
        );
        expect(moved.message).toContain("another machine or account profile");
      }),
  );

  it.effect("refuses incomplete metadata instead of falling back to the default accounts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const failure = yield* resolveServerEnvironmentWorkspace().pipe(
        Effect.provideService(HostProcessEnvironment, { T3_WORKSPACE_PROFILE_ID: "pm" }),
        Effect.provide(ServerConfig.layerTest(process.cwd(), home)),
        Effect.flip,
      );
      expect(failure.message).toContain("all four");
    }),
  );
});
