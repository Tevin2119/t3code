import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  createProviderVersionAdvisory,
  normalizeCommandPath,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { hermesMaintenance, makeHermesMaintenanceResolution } from "./HermesMaintenance.ts";

const layerRelease = (respond: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, respond()))),
  );

it.layer(NodeServices.layer)("HermesMaintenance", (it) => {
  it.effect.each([
    { name: "the checkout's own venv", launcher: ["hermes-agent", "venv", "bin", "hermes"] },
    { name: "a launcher beside the checkout", launcher: ["bin", "hermes"] },
  ])("updates a git checkout launched from $name with hermes update", ({ launcher }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const checkout = path.join(home, "hermes-agent");
      yield* fs.makeDirectory(path.join(checkout, ".git"), { recursive: true });
      yield* fs.writeFileString(path.join(checkout, "pyproject.toml"), "");
      const commandPath = path.join(home, ...launcher);
      const env = { HERMES_HOME: home };

      const capabilities = yield* hermesMaintenance.resolve({
        binaryPath: "hermes",
        resolvedCommandPath: commandPath,
        realCommandPath: commandPath,
        env,
        platform: "linux",
      });

      expect(capabilities.update).toMatchObject({
        executable: commandPath,
        args: ["update", "--yes"],
        lockKey: `hermes-git:${normalizeCommandPath(checkout)}`,
        env,
      });
      expect(capabilities.packageName).toBeNull();
    }),
  );

  it.effect("leaves an install without a checkout manual and names the command", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const commandPath = path.join(home, "venvs", "hermes-agent", "bin", "hermes");

      const capabilities = yield* hermesMaintenance.resolve({
        binaryPath: "hermes",
        resolvedCommandPath: commandPath,
        realCommandPath: commandPath,
        env: {},
        platform: "linux",
      });

      expect(
        createProviderVersionAdvisory({
          driver: ProviderDriverKind.make("hermes"),
          currentVersion: "0.21.1",
          latestVersion: "0.23.3",
          maintenanceCapabilities: capabilities,
        }),
      ).toMatchObject({
        status: "behind_latest",
        canUpdate: false,
        updateCommand: "hermes update",
      });
    }),
  );

  it.effect.each([
    {
      name: "a release tag",
      respond: () => Response.json({ tag_name: "v0.23.3" }),
      latest: "0.23.3",
    },
    {
      name: "a tag that is not a version",
      respond: () => Response.json({ tag_name: "nightly" }),
      latest: null,
    },
    {
      name: "a rate-limited response",
      respond: () => new Response("{}", { status: 403 }),
      latest: null,
    },
  ])("reads the latest version from $name on GitHub", ({ respond, latest }) =>
    Effect.gen(function* () {
      const resolve = yield* makeHermesMaintenanceResolution({ binaryPath: null }).pipe(
        Effect.provide(layerRelease(respond)),
      );
      const capabilities = yield* resolve();
      // A null answer must not fall back to npm, whose `hermes-agent` is an unofficial bridge.
      expect(capabilities.latestVersion).toBeNull();
      expect(yield* capabilities.lookupLatestVersion!).toBe(latest);
    }),
  );
});
