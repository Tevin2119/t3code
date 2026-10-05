import { EnvironmentWorkspace } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const workspaceJson = Schema.fromJsonString(EnvironmentWorkspace);
const decodeWorkspace = Schema.decodeUnknownEffect(EnvironmentWorkspace);
const decodeStoredWorkspace = Schema.decodeUnknownEffect(workspaceJson);
const encodeWorkspace = Schema.encodeEffect(workspaceJson);

export class WorkspaceBindingError extends Schema.TaggedError<WorkspaceBindingError>()(
  "WorkspaceBindingError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

const isWorkspaceBindingError = Schema.is(WorkspaceBindingError);

export const resolveServerEnvironmentWorkspace = Effect.fn("resolveServerEnvironmentWorkspace")(
  function* () {
    const environment = yield* HostProcessEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const bindingPath = path.join(config.stateDir, "workspace-profile.json");
    const raw = {
      machineId: environment.T3_WORKSPACE_MACHINE_ID,
      machineLabel: environment.T3_WORKSPACE_MACHINE_LABEL,
      profileId: environment.T3_WORKSPACE_PROFILE_ID,
      profileLabel: environment.T3_WORKSPACE_PROFILE_LABEL,
      ...(environment.T3_WORKSPACE_ALLOCATION_SCOPE
        ? { allocationScope: environment.T3_WORKSPACE_ALLOCATION_SCOPE }
        : {}),
    };
    const configured = Object.values(raw).some((value) => value !== undefined);
    const exists = yield* fileSystem.exists(bindingPath);
    if (!configured) {
      if (exists) {
        return yield* new WorkspaceBindingError({
          detail:
            "This T3 home belongs to a named account profile. Start it with its profile launcher.",
        });
      }
      return undefined;
    }
    const workspace = yield* decodeWorkspace(raw).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceBindingError({
            detail: "Provide all four T3_WORKSPACE machine and profile identifiers and labels.",
            cause,
          }),
      ),
    );
    if (!exists) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* fileSystem.makeTempFileScoped({ directory: config.stateDir });
          const encoded = yield* encodeWorkspace(workspace);
          yield* fileSystem.writeFileString(temporary, encoded);
          yield* fileSystem.chmod(temporary, 0o600);
          yield* fileSystem
            .link(temporary, bindingPath)
            .pipe(
              Effect.catch((cause) =>
                cause.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(cause),
              ),
            );
        }),
      );
    }
    const stored = yield* fileSystem
      .readFileString(bindingPath)
      .pipe(Effect.flatMap(decodeStoredWorkspace));
    if (stored.machineId !== workspace.machineId || stored.profileId !== workspace.profileId) {
      return yield* new WorkspaceBindingError({
        detail:
          "This T3 home belongs to another machine or account profile. Use a separate home; profile relabelling is refused.",
      });
    }
    return workspace;
  },
  Effect.mapError((cause) =>
    isWorkspaceBindingError(cause)
      ? cause
      : new WorkspaceBindingError({
          detail: "Could not verify this T3 home's account-profile binding.",
          cause,
        }),
  ),
);
