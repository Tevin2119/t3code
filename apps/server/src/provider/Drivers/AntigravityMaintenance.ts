import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  AntigravityInstallationError,
  type AntigravityInstallation,
} from "../AntigravityInstallation.ts";

const DRIVER = ProviderDriverKind.make("antigravity");

type Installation = Pick<
  AntigravityInstallation["Service"],
  "start" | "state" | "changes" | "latestVersion"
>;

/**
 * Only the runtime T3 Code downloaded is updated here, through the install that Antigravity
 * setup starts. A custom executable or one found on PATH belongs to whoever installed it.
 */
export const resolveAntigravityMaintenance = Effect.fn("AntigravityMaintenance.resolve")(
  function* (input: { readonly installation: Installation; readonly binaryPath: string }) {
    const { installation } = input;
    if (input.binaryPath.trim() || (yield* installation.state).installedVersion === null) {
      return makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null });
    }
    const run = Effect.fn("AntigravityMaintenance.run")(function* (
      onProgress: (line: string) => Effect.Effect<void>,
    ) {
      const started = yield* installation.start;
      const mine = (state: ProviderInstallState) => state.operationId === started.operationId;
      let reported: string | null = null;
      const settled = yield* installation.changes.pipe(
        Stream.tap((state) => {
          if (!mine(state) || state.message === null || state.message === reported) {
            return Effect.void;
          }
          reported = state.message;
          return onProgress(state.message);
        }),
        Stream.filter(
          (state) =>
            !mine(state) ||
            state.phase === "succeeded" ||
            state.phase === "failed" ||
            state.phase === "cancelled",
        ),
        Stream.runHead,
      );
      if (Option.isSome(settled) && mine(settled.value) && settled.value.phase === "succeeded") {
        return;
      }
      return yield* new AntigravityInstallationError({
        operation: "install",
        detail:
          (Option.isSome(settled) && mine(settled.value) ? settled.value.message : null) ??
          "The Antigravity update did not finish. Retry it in Antigravity setup.",
      });
    });
    return {
      provider: DRIVER,
      packageName: null,
      latestVersion: null,
      lookupLatestVersion: installation.latestVersion,
      update: {
        command: "antigravity",
        executable: "antigravity",
        args: [],
        lockKey: "antigravity-managed",
        run,
      },
    } satisfies ProviderMaintenanceCapabilities;
  },
);
