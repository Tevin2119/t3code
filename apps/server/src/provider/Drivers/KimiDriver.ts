/**
 * Kimi Code driver.
 *
 * `kimi acp` is a first-class ACP agent, so this driver composes the shared ACP
 * runtime the same way the Grok driver does rather than owning a transport.
 * Sign-in is a device-code flow run in a terminal (`kimi login`), which the CLI
 * performs and persists itself — there is no browser callback for the server to
 * host, so the driver exposes no `auth` controller and reports login state from
 * the snapshot probe instead.
 *
 * @module provider/Drivers/KimiDriver
 */
import { KimiSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeKimiTextGeneration } from "../../textGeneration/KimiTextGeneration.ts";
import { makeKimiAcpRuntime } from "../acp/KimiAcpSupport.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeKimiAdapter, type KimiAdapterOptions } from "../Layers/KimiAdapter.ts";
import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
} from "../Layers/KimiProvider.ts";
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

const decodeKimiSettings = Schema.decodeSync(KimiSettings);

const DRIVER_KIND = ProviderDriverKind.make("kimi");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@moonshot-ai/kimi-code",
});

export type KimiDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | ProviderEventLoggers
  | ServerSettingsService;

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
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
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
          environment: processEnv,
          childProcessSpawner: spawner,
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      const adapter = yield* makeKimiAdapter(effectiveConfig, {
        instanceId,
        makeRuntime,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeKimiTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkKimiProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
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
      } satisfies ProviderInstance;
    }),
};
