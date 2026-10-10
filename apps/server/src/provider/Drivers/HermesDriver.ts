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

import type { AcpAdapterV2Env } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { makeHermesTextGeneration } from "../../textGeneration/HermesTextGeneration.ts";
import { makeHermesAcpRuntime, makeHermesEnvironment } from "../acp/HermesAcpSupport.ts";
import { makeCliAuth } from "../CliAuth.ts";
import { ProviderDriverError } from "../Errors.ts";
import { hermesUsageReader, type HermesUsageReaderEnv } from "./hermesUsage.ts";
import { readHermesTurnEnd } from "../acp/HermesTurnEnd.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeHermesAdapter, type HermesAdapterOptions } from "../HermesAdapter.ts";
import {
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
  probeHermesAuthenticated,
  readHermesRuntimeConfig,
} from "../HermesProvider.ts";
import { readHermesUsageLimits } from "../hermesUsageLimits.ts";
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

const decodeHermesSettings = Schema.decodeSync(HermesSettings);

const DRIVER_KIND = ProviderDriverKind.make("hermes");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "hermes-agent",
});

export type HermesDriverEnv =
  | AcpAdapterV2Env
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers;

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv, HermesUsageReaderEnv> = {
  driverKind: DRIVER_KIND,
  usage: hermesUsageReader,
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
      // One environment for the ACP agent, the status probes and the credential
      // check, so a scoped `homePath` governs everything the card reports.
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const processEnv = makeHermesEnvironment(
        config,
        yield* mergeProviderInstanceEnvironment(environment),
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
          ? expandHomePath(effectiveConfig.homePath, homeDirectory)
          : processEnv["HERMES_HOME"]?.trim() ||
            (processEnv["LOCALAPPDATA"]
              ? `${processEnv["LOCALAPPDATA"]}/hermes`
              : expandHomePath("~/.hermes", homeDirectory));
      const orchestrationAdapter = yield* makeHermesAdapter(effectiveConfig, {
        instanceId,
        makeRuntime,
        turnEnd: (sessionId) =>
          readHermesTurnEnd({ sessionId, storeFile: `${hermesHome}/state.db` }),
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

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
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
