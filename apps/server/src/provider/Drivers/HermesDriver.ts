/**
 * Hermes Agent driver.
 *
 * `hermes acp` is a first-class ACP agent, so this driver composes the shared
 * ACP runtime the same way the Kimi driver does rather than owning a transport.
 * Hermes fronts whichever inference provider `hermes model` selected on the
 * host — DeepSeek on a default install — so T3 Code holds no key of its own.
 *
 * There is no headless sign-in: Hermes' setup is an interactive wizard
 * (`hermes acp --setup` / `hermes model`) that picks a provider and model in a
 * TTY, and its sign-out (`hermes logout`) is scoped to that same choice. So the
 * auth controller here verifies rather than signs in, the way pi's does:
 * `start` re-reads the CLI's credential verdict and reports it, and the failure
 * text sends the user to the wizard.
 *
 * @module provider/Drivers/HermesDriver
 */
import { HermesSettings, ProviderDriverKind } from "@t3tools/contracts";
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
import { makeHermesTextGeneration } from "../../textGeneration/HermesTextGeneration.ts";
import { makeHermesAcpRuntime, makeHermesEnvironment } from "../acp/HermesAcpSupport.ts";
import { makeCliAuth } from "../CliAuth.ts";
import { ProviderDriverError } from "../Errors.ts";
import { readHermesTurnEnd } from "../acp/HermesTurnEnd.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { makeHermesAdapter, type HermesAdapterOptions } from "../HermesAdapter.ts";
import {
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
  probeHermesAuthenticated,
  readHermesRuntimeConfig,
} from "../HermesProvider.ts";
import { readHermesUsageLimits } from "../hermesUsageLimits.ts";
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

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const DRIVER_KIND = ProviderDriverKind.make("hermes");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "hermes-agent",
});

export type HermesDriverEnv =
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

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: (): HermesSettings => decodeHermesSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
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
      const processEnv = makeHermesEnvironment(
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
      const effectiveConfig = { ...config, enabled } satisfies HermesSettings;

      const makeRuntime: HermesAdapterOptions["makeRuntime"] = (input) =>
        makeHermesAcpRuntime({
          ...input,
          hermesSettings: effectiveConfig,
          environment: { ...processEnv, ...input.processEnvironment },
          childProcessSpawner: spawner,
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      // Where Hermes keeps its sessions: the home it was given, or its own.
      const hermesHome =
        effectiveConfig.homePath.trim().length > 0
          ? expandHomePath(effectiveConfig.homePath)
          : processEnv["HERMES_HOME"]?.trim() ||
            (processEnv["LOCALAPPDATA"]
              ? `${processEnv["LOCALAPPDATA"]}/hermes`
              : expandHomePath("~/.hermes"));
      const orchestrationAdapter = makeHermesAdapter(effectiveConfig, {
        instanceId,
        makeRuntime,
        turnEnd: (sessionId) =>
          readHermesTurnEnd({ sessionId, storeFile: `${hermesHome}/state.db` }),
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
      const textGeneration = yield* makeHermesTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkHermesProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.flatMap((snapshot) =>
          effectiveConfig.enabled && snapshot.installed && snapshot.auth.status === "authenticated"
            ? readHermesRuntimeConfig(effectiveConfig, processEnv).pipe(
                Effect.flatMap((runtime) =>
                  readHermesUsageLimits({
                    provider: runtime?.provider ?? "",
                    environment: processEnv,
                  }),
                ),
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
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<HermesSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialHermesProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Hermes snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const auth = yield* makeCliAuth({
        instanceId,
        providerName: "Hermes",
        verify: probeHermesAuthenticated(effectiveConfig, processEnv).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
        signInHint:
          "Hermes has no usable credentials. Run `hermes acp --setup` in a terminal on this environment to choose a provider and model, then check again.",
        signOutHint: "Hermes signs out from its own CLI. Run `hermes logout` in a terminal.",
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
