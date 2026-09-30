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
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeDeepSeekTextGeneration } from "../../textGeneration/DeepSeekTextGeneration.ts";
import { makeDeepSeekAcpRuntime, makeDeepSeekEnvironment } from "../acp/DeepSeekAcpSupport.ts";
import { makeCliAuth } from "../CliAuth.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDeepSeekAdapter, type DeepSeekAdapterOptions } from "../Layers/DeepSeekAdapter.ts";
import { readDeepSeekBalance } from "../Layers/deepseekBalance.ts";
import {
  buildInitialDeepSeekProviderSnapshot,
  checkDeepSeekProviderStatus,
  probeDeepSeekAuthenticated,
} from "../Layers/DeepSeekProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
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
          environment: processEnv,
          childProcessSpawner: spawner,
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      const adapter = yield* makeDeepSeekAdapter(effectiveConfig, {
        instanceId,
        makeRuntime,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
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
        adapter,
        textGeneration,
        auth,
      } satisfies ProviderInstance;
    }),
};
