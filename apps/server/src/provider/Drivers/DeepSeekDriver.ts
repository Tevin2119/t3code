/**
 * DeepSeek Harness driver.
 *
 * `dsh --profile acp` is a first-class ACP agent, so this driver composes the
 * shared ACP runtime the same way the Hermes driver does rather than owning a
 * transport. The harness keeps the DeepSeek API key in its own home, so T3 Code
 * holds no key of its own.
 *
 * There is no headless sign-in: the key is saved on the credentials page of
 * `dsh web`. So the auth controller here verifies rather than signs in, the way
 * pi's does: `start` re-reads whether a key is stored and reports it.
 *
 * @module provider/Drivers/DeepSeekDriver
 */
import { DeepSeekSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeDeepSeekTextGeneration } from "../../textGeneration/DeepSeekTextGeneration.ts";
import {
  makeDeepSeekAcpRuntime,
  makeDeepSeekEnvironment,
  deepseekPermissionModeFor,
} from "../acp/DeepSeekAcpSupport.ts";
import { makeCliAuth } from "../CliAuth.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDeepSeekAdapter, type DeepSeekAdapterOptions } from "../DeepSeekAdapter.ts";
import { readDeepSeekBalance } from "../deepseekBalance.ts";
import {
  buildInitialDeepSeekProviderSnapshot,
  checkDeepSeekProviderStatus,
  probeDeepSeekAuthenticated,
} from "../DeepSeekProvider.ts";
import { ProviderEventLoggers } from "../ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);

const DRIVER_KIND = ProviderDriverKind.make("deepseek");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@deepseek-ai/dsh",
});

export type DeepSeekDriverEnv =
  | ServerConfig.ServerConfig
  | IdAllocator.IdAllocatorV2
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerSettingsService;

export const DeepSeekDriver: ProviderDriver<DeepSeekSettings, DeepSeekDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "DeepSeek",
    supportsMultipleInstances: true,
  },
  configSchema: DeepSeekSettings,
  defaultConfig: (): DeepSeekSettings => decodeDeepSeekSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const httpClient = yield* HttpClient.HttpClient;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
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
      // One environment for the ACP agent, the status probes and the credential
      // check, so a scoped `homePath` governs everything the card reports.
      const processEnv = makeDeepSeekEnvironment(
        config,
        mergeProviderInstanceEnvironment(environment),
      );
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
      const effectiveConfig = { ...config, enabled } satisfies DeepSeekSettings;

      const makeRuntime: DeepSeekAdapterOptions["makeRuntime"] = (input) =>
        makeDeepSeekAcpRuntime({
          ...input,
          deepseekSettings: effectiveConfig,
          permissionMode: deepseekPermissionModeFor(input.runtimePolicy.runtimeMode) ?? "read-only",
          environment: { ...processEnv, ...input.processEnvironment },
          childProcessSpawner: spawner,
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      const orchestrationAdapter = makeDeepSeekAdapter(effectiveConfig, {
        instanceId,
        makeRuntime,
        crypto,
        fileSystem,
        serverConfig,
        idAllocator,
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: eventLoggers.native,
            provider: DRIVER_KIND,
            threadId,
          }),
      });
      const textGeneration = yield* makeDeepSeekTextGeneration(effectiveConfig, processEnv);

      // DeepSeek bills prepaid credit rather than plan windows: its balance goes with the check.
      const checkProvider = checkDeepSeekProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.flatMap((snapshot) =>
          effectiveConfig.enabled && snapshot.installed
            ? readDeepSeekBalance(processEnv).pipe(
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

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DeepSeekSettings>>(
        {
          resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            buildInitialDeepSeekProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build DeepSeek snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const auth = yield* makeCliAuth({
        instanceId,
        providerName: "DeepSeek",
        verify: probeDeepSeekAuthenticated(processEnv).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
        signInHint:
          "DeepSeek has no API key. Run `dsh web` in a terminal on this environment, save a key on its credentials page, then check again.",
        signOutHint:
          "The DeepSeek key is removed from the harness itself. Run `dsh web` and clear it on its credentials page.",
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
