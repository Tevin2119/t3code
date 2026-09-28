import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { buildRuntimeInstructions } from "../provider/RuntimeInstructions.ts";
import * as DeliveryService from "./DeliveryService.ts";
import * as DeliveryThreadSession from "./DeliveryThreadSession.ts";

const receipt = (team: string, session: string) => ({
  identity: {
    session,
    team,
    role: team === "rnd" ? "researcher" : "lead-developer",
    seat: "developer",
    harness: "claude",
    configuration: `${team}@2#0123456789abcdef`,
    requestedModel: "claude-fable-5-1",
    memoryScope: `team:${team}`,
    tools: ["delivery"],
    project: "C:/work/repo",
  },
});

const RequestBody = Schema.Struct({
  team: Schema.optional(Schema.String),
  harness: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  thread: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
});
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));

interface Engine {
  readonly requests: Array<{ method: string; path: string; body: unknown }>;
  down: boolean;
}

const layer = (
  engine: Engine,
  options: {
    enabled?: boolean;
    engineUrl?: string;
    prefix: string;
    /** The state folder of an earlier service, to start a second one on the same files. */
    config?: ServerConfig.ServerConfig["Service"];
  },
) =>
  // Fresh, so that a second service in one test is a second start and not the first again.
  Layer.fresh(DeliveryService.layer).pipe(
    Layer.provideMerge(
      options.config
        ? Layer.succeed(ServerConfig.ServerConfig, options.config)
        : ServerConfig.layerTest(process.cwd(), { prefix: options.prefix }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      ServerSettings.layerTest({
        delivery: {
          enabled: options.enabled ?? true,
          engineUrl: options.engineUrl ?? "http://127.0.0.1:4320",
        },
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.suspend(() => {
            // A refused connection is a failure of the request, as it is with a real client.
            if (engine.down) return Effect.fail(new Error("connection refused") as never);
            const url = new URL(request.url);
            const body =
              request.body._tag === "Uint8Array"
                ? decodeBody(new TextDecoder().decode(request.body.body))
                : undefined;
            engine.requests.push({ method: request.method, path: url.pathname, body });
            const json = (value: unknown, status = 200) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(value, { status })));
            if (request.method === "POST" && url.pathname === "/api/sessions") {
              if (body?.team === "sales") return json({ error: 'no team "sales"' }, 404);
              if (body?.harness === "kimi" && !body.role) {
                return json(
                  {
                    error: "kimi can take more than one role in team rnd; choose one",
                    roles: [{ role: "challenger" }, { role: "scout" }],
                  },
                  409,
                );
              }
              return json(
                receipt(body?.team ?? "development", `session-${engine.requests.length}`),
              );
            }
            if (url.pathname.endsWith("/launch")) {
              return json({
                instructions: "You are on the team.\n",
                instructionsFile: "C:/data/sessions/s/instructions.md",
                skillFolder: "C:/data/sessions/s/skills/team-tools",
                servers: {
                  delivery: {
                    command: "C:/node.exe",
                    args: ["C:/engine/delivery-tools.mjs"],
                    env: { DELIVERY_TEAM: "development", DELIVERY_SEAT: "developer" },
                  },
                },
              });
            }
            if (url.pathname === "/api/lanes") return json({ lanes: [], view: "development" });
            return json({ error: "not found" }, 404);
          }),
        ),
      ),
    ),
  );

const engine = (): Engine => ({ requests: [], down: false });
const threadId = (value: string) => ThreadId.make(value);

describe("DeliveryService", () => {
  it.effect("relays nothing while delivery is turned off", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const read = yield* delivery.read({ path: "/api/lanes" as never }).pipe(Effect.flip);
      expect(read.reason).toBe("disabled");
      const bound = yield* delivery
        .bindThread({
          threadId: threadId("thread-off"),
          team: "development" as never,
          driver: "claudeAgent" as never,
          cwd: "C:/work/repo" as never,
        })
        .pipe(Effect.flip);
      expect(bound.reason).toBe("disabled");
      expect(yield* delivery.prepareThread(threadId("thread-off"))).toBe(false);
      expect(fake.requests).toEqual([]);
    }).pipe(Effect.provide(layer(fake, { enabled: false, prefix: "t3-delivery-off-" })));
  });

  it.effect("only ever talks to an engine on this host", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const error = yield* delivery.read({ path: "/api/lanes" as never }).pipe(Effect.flip);
      expect(error.reason).toBe("invalid");
      expect(fake.requests).toEqual([]);
    }).pipe(
      Effect.provide(
        layer(fake, { engineUrl: "http://engine.example.com:4320", prefix: "t3-delivery-far-" }),
      ),
    );
  });

  it.effect("binds a thread once, maps the driver, and keeps the thread on its team", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const id = threadId("thread-bind");
      expect(yield* delivery.threadBinding(id)).toBeNull();
      const binding = yield* delivery.bindThread({
        threadId: id,
        team: "development" as never,
        driver: "claudeAgent" as never,
        cwd: "C:/work/repo" as never,
      });
      expect(binding.team).toBe("development");
      expect(binding.role).toBe("lead-developer");
      expect(binding.configuration).toBe("development@2#0123456789abcdef");
      expect(fake.requests[0]?.body).toMatchObject({
        team: "development",
        harness: "claude",
        mode: "chat",
        thread: "thread-bind",
      });
      expect(yield* delivery.threadBinding(id)).toEqual(binding);

      // Asked again for the same team, the thread keeps the binding it has.
      const again = yield* delivery.bindThread({
        threadId: id,
        team: "development" as never,
        driver: "claudeAgent" as never,
        cwd: "C:/work/repo" as never,
      });
      expect(again.session).toBe(binding.session);
      expect(fake.requests.length).toBe(1);

      // Another team is another thread.
      const moved = yield* delivery
        .bindThread({
          threadId: id,
          team: "rnd" as never,
          driver: "claudeAgent" as never,
          cwd: "C:/work/repo" as never,
        })
        .pipe(Effect.flip);
      expect(moved.reason).toBe("refused");
      expect(moved.detail).toContain("Start a new thread");
      expect((yield* delivery.threadBinding(id))?.team).toBe("development");
    }).pipe(Effect.provide(layer(fake, { prefix: "t3-delivery-bind-" })));
  });

  it.effect("passes on the engine's refusal with the choices it offered", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const unknown = yield* delivery
        .bindThread({
          threadId: threadId("thread-a"),
          team: "sales" as never,
          driver: "claudeAgent" as never,
          cwd: "C:/work/repo" as never,
        })
        .pipe(Effect.flip);
      expect([unknown.reason, unknown.status, unknown.detail]).toEqual([
        "refused",
        404,
        'no team "sales"',
      ]);
      const ambiguous = yield* delivery
        .bindThread({
          threadId: threadId("thread-b"),
          team: "rnd" as never,
          driver: "kimi" as never,
          cwd: "C:/work/repo" as never,
        })
        .pipe(Effect.flip);
      expect(ambiguous.status).toBe(409);
      expect(ambiguous.body).toMatchObject({ roles: [{ role: "challenger" }, { role: "scout" }] });
      const cursor = yield* delivery
        .bindThread({
          threadId: threadId("thread-c"),
          team: "development" as never,
          driver: "cursor" as never,
          cwd: "C:/work/repo" as never,
        })
        .pipe(Effect.flip);
      expect(cursor.reason).toBe("unsupportedHarness");
      // A refused thread is not bound, so it starts as an ordinary thread.
      expect(yield* delivery.threadBinding(threadId("thread-a"))).toBeNull();
      expect(yield* delivery.prepareThread(threadId("thread-a"))).toBe(false);
    }).pipe(Effect.provide(layer(fake, { prefix: "t3-delivery-refuse-" })));
  });

  it.effect(
    "gives a bound thread its team's instructions and tools in every harness's form",
    () => {
      const fake = engine();
      return Effect.gen(function* () {
        const delivery = yield* DeliveryService.DeliveryService;
        const id = threadId("thread-launch");
        const other = threadId("thread-unbound");
        yield* delivery.bindThread({
          threadId: id,
          team: "development" as never,
          driver: "claudeAgent" as never,
          cwd: "C:/work/repo" as never,
        });
        expect(yield* DeliveryThreadSession.prepareDeliveryThread(id)).toBe(true);

        const instructions = buildRuntimeInstructions({ harness: "Claude Code", threadId: id });
        expect(instructions).toContain(
          '<team_instructions team="development" role="lead-developer" configuration="development@2#0123456789abcdef">',
        );
        expect(instructions).toContain("You are on the team.");
        // An unbound thread is told nothing about any team.
        expect(buildRuntimeInstructions({ harness: "Claude Code", threadId: other })).toBe(
          buildRuntimeInstructions({ harness: "Claude Code" }),
        );

        expect(DeliveryThreadSession.deliveryAcpServers(id)).toEqual([
          {
            name: "delivery",
            command: "C:/node.exe",
            args: ["C:/engine/delivery-tools.mjs"],
            env: [
              { name: "DELIVERY_TEAM", value: "development" },
              { name: "DELIVERY_SEAT", value: "developer" },
            ],
          },
        ]);
        expect(DeliveryThreadSession.deliveryStdioServers(id).delivery?.env.DELIVERY_SEAT).toBe(
          "developer",
        );
        const codex = DeliveryThreadSession.deliveryCodexArgs(id);
        expect(codex).toContain('mcp_servers.delivery.command="C:/node.exe"');
        expect(codex).toContain('mcp_servers.delivery.args=["C:/engine/delivery-tools.mjs"]');
        expect(codex).toContain(
          'mcp_servers.delivery.env={DELIVERY_TEAM="development",DELIVERY_SEAT="developer"}',
        );
        expect(codex.find((value) => value.startsWith("developer_instructions="))).toContain(
          "You are on the team.\\n",
        );
        expect(DeliveryThreadSession.deliveryPiLaunch(id)).toEqual({
          args: [
            "--append-system-prompt",
            "C:/data/sessions/s/instructions.md",
            "--skill",
            "C:/data/sessions/s/skills/team-tools",
          ],
          env: { DELIVERY_TEAM: "development", DELIVERY_SEAT: "developer" },
        });
        expect(DeliveryThreadSession.deliveryAcpServers(other)).toEqual([]);
        expect(DeliveryThreadSession.deliveryCodexArgs(other)).toEqual([]);
        expect(DeliveryThreadSession.deliveryPiLaunch(other)).toEqual({ args: [], env: {} });
      }).pipe(Effect.provide(layer(fake, { prefix: "t3-delivery-launch-" })));
    },
  );

  it.effect("does not start a bound thread as an ordinary one when the engine is down", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const id = threadId("thread-down");
      yield* delivery.bindThread({
        threadId: id,
        team: "development" as never,
        driver: "claudeAgent" as never,
        cwd: "C:/work/repo" as never,
      });
      fake.down = true;
      const error = yield* DeliveryThreadSession.prepareDeliveryThread(id).pipe(Effect.flip);
      expect(error.reason).toBe("unreachable");
      // The thread is still bound, and is told so while the engine is away.
      expect((yield* delivery.threadBinding(id))?.team).toBe("development");
      const read = yield* delivery.read({ path: "/api/lanes" as never }).pipe(Effect.flip);
      expect(read.reason).toBe("unreachable");
      fake.down = false;
      expect(yield* DeliveryThreadSession.prepareDeliveryThread(id)).toBe(true);
    }).pipe(Effect.provide(layer(fake, { prefix: "t3-delivery-down-" })));
  });

  it.effect("remembers bindings across a restart", () => {
    const fake = engine();
    const id = threadId("thread-restart");
    const shared = ServerConfig.layerTest(process.cwd(), { prefix: "t3-delivery-restart-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const again = <E>(body: Effect.Effect<void, E, DeliveryService.DeliveryService>) =>
        body.pipe(Effect.provide(layer(fake, { prefix: "unused-", config })));
      yield* again(
        Effect.gen(function* () {
          const delivery = yield* DeliveryService.DeliveryService;
          yield* delivery.bindThread({
            threadId: id,
            team: "rnd" as never,
            driver: "claudeAgent" as never,
            cwd: "C:/work/repo" as never,
          });
        }),
      );
      yield* again(
        Effect.gen(function* () {
          const delivery = yield* DeliveryService.DeliveryService;
          const binding = yield* delivery.threadBinding(id);
          expect([binding?.team, binding?.role]).toEqual(["rnd", "researcher"]);
        }),
      );
    }).pipe(Effect.provide(shared));
  });
});
