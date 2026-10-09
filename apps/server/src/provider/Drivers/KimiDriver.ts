/**
 * Kimi Code driver.
 *
 * `kimi acp` is a first-class ACP agent, so this driver composes the shared ACP
 * runtime the same way the Grok driver does rather than owning a transport.
 *
 * Sign-in is a device-code flow: `kimi login` prints a verification URL plus a
 * short code and polls until the user approves, so `CliAuth` runs it as a child
 * process and republishes the code instead of hosting a browser callback.
 * Sign-out goes the other way — the ACP agent advertises `auth.logout`, so it
 * is an ACP request, the same shape `AntigravityAuth` uses.
 *
 * @module provider/Drivers/KimiDriver
 */
import { KimiSettings, ProviderDriverKind, ProviderSetupError } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { AcpAdapterV2Env } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { makeKimiTextGeneration } from "../../textGeneration/KimiTextGeneration.ts";
import {
  kimiLoginArgs,
  makeKimiAcpRuntime,
  parseKimiLoginChallenge,
} from "../acp/KimiAcpSupport.ts";
import { makeCliAuth } from "../CliAuth.ts";
import { ProviderDriverError } from "../Errors.ts";
import { countKimiTurnEnds, readKimiTurnEnd } from "../acp/KimiTurnEnd.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { makeKimiAdapter, type KimiAdapterOptions } from "../KimiAdapter.ts";
import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
  probeKimiAuthenticated,
} from "../KimiProvider.ts";
import { readKimiUsageLimits } from "../kimiUsageLimits.ts";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const isSetupError = Schema.is(ProviderSetupError);

const DRIVER_KIND = ProviderDriverKind.make("kimi");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@moonshot-ai/kimi-code",
});

export type KimiDriverEnv =
  | AcpAdapterV2Env
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers;

export const KimiDriver: ProviderDriver<KimiSettings, KimiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kimi",
    supportsMultipleInstances: true,
  },
  configSchema: KimiSettings,
  defaultConfig: (): KimiSettings => decodeKimiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const eventLoggers = yield* ProviderEventLoggers;
      const selfInvocation = yield* resolveSelfInvocation().pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Could not locate the provider bridge runtime.",
              cause,
            }),
        ),
      );
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies KimiSettings;

      const makeRuntime: KimiAdapterOptions["makeRuntime"] = (input) =>
        makeKimiAcpRuntime({
          ...input,
          kimiSettings: effectiveConfig,
          environment: { ...processEnv, ...input.processEnvironment },
          childProcessSpawner: spawner,
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      // Where Kimi keeps its sessions: the home it was given, or its own.
      const kimiHome = processEnv["KIMI_CODE_HOME"]?.trim() || expandHomePath("~/.kimi-code");
      const withFiles = <A>(effect: Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>) =>
        effect.pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
      const orchestrationAdapter = yield* makeKimiAdapter(effectiveConfig, {
        instanceId,
        makeRuntime,
        countTurnEnds: (sessionId) => withFiles(countKimiTurnEnds({ sessionId, home: kimiHome })),
        turnEnd: (sessionId, endsBefore) =>
          withFiles(readKimiTurnEnd({ sessionId, home: kimiHome, endsBefore })),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: eventLoggers.native,
            provider: DRIVER_KIND,
            threadId,
          }),
      });
      const textGeneration = yield* makeKimiTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkKimiProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.flatMap((snapshot) =>
          effectiveConfig.enabled && snapshot.installed && snapshot.auth.status === "authenticated"
            ? readKimiUsageLimits(processEnv).pipe(
                Effect.map((usageLimits) => ({ ...snapshot, usageLimits })),
              )
            : Effect.succeed(snapshot),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<KimiSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialKimiProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Kimi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const setupError = (operation: string, detail: string) =>
        new ProviderSetupError({ instanceId, operation, detail });

      const auth = yield* makeCliAuth({
        instanceId,
        providerName: "Kimi",
        login: {
          command: Effect.gen(function* () {
            const binary = effectiveConfig.binaryPath || "kimi";
            const resolved = yield* resolveSpawnCommand(
              binary,
              kimiLoginArgs(effectiveConfig.region),
              { env: processEnv },
            );
            return ChildProcess.make(resolved.command, resolved.args, {
              env: processEnv,
              shell: resolved.shell,
            });
          }).pipe(
            Effect.mapError(() =>
              setupError("start", "Kimi Code CLI (`kimi`) is not installed or not on PATH."),
            ),
          ),
          parseChallenge: parseKimiLoginChallenge,
          // The CLI prints "Code expires in 1800s"; expire the flow with it
          // rather than earlier, or the UI cancels a code that still works.
          timeoutMs: 1_800_000,
        },
        verify: probeKimiAuthenticated(effectiveConfig, processEnv).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
        signInHint: "Kimi sign-in did not complete. Start sign-in again.",
        // `kimi acp` advertises `auth.logout`, so sign-out is an ACP request
        // against a throwaway runtime rather than another CLI invocation.
        logout: (stopSessions) =>
          Effect.gen(function* () {
            yield* stopSessions;
            // Built here rather than through the adapter's `makeRuntime`, whose
            // return type is narrowed to the session surface the adapter uses.
            const runtime = yield* makeKimiAcpRuntime({
              cwd: process.cwd(),
              clientInfo: { name: "t3-code-auth", version: "0.0.0" },
              kimiSettings: effectiveConfig,
              environment: processEnv,
              childProcessSpawner: spawner,
            }).pipe(Effect.provideService(Crypto.Crypto, crypto));
            const initialized = yield* runtime.initialize();
            if (!initialized.agentCapabilities?.auth?.logout) {
              return yield* setupError(
                "logout",
                "This Kimi Code CLI version does not support sign-out. Update the CLI.",
              );
            }
            yield* runtime.request("logout", {});
          }).pipe(
            Effect.scoped,
            Effect.mapError((cause) =>
              isSetupError(cause)
                ? cause
                : setupError("logout", "Kimi sign-out failed. Try again."),
            ),
          ),
        onSettled: snapshot.refresh.pipe(Effect.asVoid),
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
        auth,
      } satisfies ProviderInstance;
    }),
};
