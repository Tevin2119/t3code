import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { buildRuntimeInstructions } from "../provider/RuntimeInstructions.ts";
import * as DeliveryService from "./DeliveryService.ts";
import * as DeliveryThreadSession from "./DeliveryThreadSession.ts";

const REPO = "C:/work/repo";
const ROLE_BY_HARNESS: Record<string, string> = {
  claude: "lead-developer",
  codex: "team-lead",
  kimi: "qa-validate",
};

const RequestBody = Schema.Struct({
  team: Schema.optional(Schema.String),
  harness: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  thread: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
});
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));

interface Identity {
  session: string;
  team: string;
  role: string;
  seat: string;
  harness: string;
  configuration: string;
  requestedModel: string | null;
  memoryScope: string;
  tools: Array<string>;
  project: string;
}

interface Engine {
  readonly requests: Array<{ method: string; path: string; body: unknown }>;
  readonly sessions: Map<string, Identity>;
  down: boolean;
  /** Changes what the engine says a session is, as a team edited behind a thread's back would. */
  tamper: ((identity: Identity) => Identity) | null;
}

const engine = (): Engine => ({ requests: [], sessions: new Map(), down: false, tamper: null });
const threadId = (value: string) => ThreadId.make(value);

const layer = (
  fake: Engine,
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
            if (fake.down) return Effect.fail(new Error("connection refused") as never);
            const url = new URL(request.url);
            const body =
              request.body._tag === "Uint8Array"
                ? decodeBody(new TextDecoder().decode(request.body.body))
                : undefined;
            fake.requests.push({ method: request.method, path: url.pathname, body });
            const json = (value: unknown, status = 200) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(value, { status })));
            if (request.method === "POST" && url.pathname === "/api/sessions") {
              if (body?.team === "sales") return json({ error: 'no team "sales"' }, 404);
              const harness = body?.harness ?? "claude";
              const team = body?.team ?? "development";
              const identity: Identity = {
                session: `session-${fake.sessions.size + 1}`,
                team,
                role: body?.role ?? ROLE_BY_HARNESS[harness] ?? "researcher",
                seat: "developer",
                harness,
                configuration: `${team}@2#0123456789abcdef`,
                requestedModel: "claude-fable-5-1",
                memoryScope: `team:${team}`,
                tools: ["delivery"],
                project: body?.cwd ?? REPO,
              };
              fake.sessions.set(identity.session, identity);
              return json({ identity });
            }
            if (url.pathname === "/api/repository") {
              const folder = url.searchParams.get("folder") ?? "";
              // A worktree of the repository has the repository as its root.
              const inside = folder
                .replaceAll("\\", "/")
                .toLowerCase()
                .startsWith(REPO.toLowerCase());
              return json({ readable: true, root: inside ? REPO : folder });
            }
            const launch = /^\/api\/sessions\/([\w-]+)\/launch$/.exec(url.pathname);
            if (launch) {
              const identity = fake.sessions.get(launch[1]!);
              if (!identity) return json({ error: "no session" }, 404);
              return json({
                identity: fake.tamper ? fake.tamper(identity) : identity,
                instructions: `You are on team ${identity.team} as ${identity.role}.\n`,
                instructionsFile: "C:/data/sessions/s/instructions.md",
                skillFolder: "C:/data/sessions/s/skills/team-tools",
                servers: {
                  delivery: {
                    command: "C:/node.exe",
                    args: ["C:/engine/delivery-tools.mjs"],
                    env: { DELIVERY_TEAM: identity.team, DELIVERY_SEAT: identity.seat },
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

const bind = (
  delivery: DeliveryService.DeliveryService["Service"],
  id: ThreadId,
  overrides: { team?: string; driver?: string; role?: string; cwd?: string } = {},
) =>
  delivery.bindThread({
    threadId: id,
    team: (overrides.team ?? "development") as never,
    driver: (overrides.driver ?? "claudeAgent") as never,
    cwd: (overrides.cwd ?? REPO) as never,
    ...(overrides.role ? { role: overrides.role as never } : {}),
  });

const CLAUDE_HERE = { driver: "claudeAgent", cwd: REPO };

describe("DeliveryService", () => {
  it.effect("relays nothing while delivery is turned off", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const read = yield* delivery.read({ path: "/api/lanes" as never }).pipe(Effect.flip);
      expect(read.reason).toBe("disabled");
      const bound = yield* bind(delivery, threadId("thread-off")).pipe(Effect.flip);
      expect(bound.reason).toBe("disabled");
      // The failed choice is on record: the thread is held, not free.
      const held = yield* delivery
        .prepareThread(threadId("thread-off"), CLAUDE_HERE)
        .pipe(Effect.flip);
      expect(held.reason).toBe("pending");
      // A thread nobody chose a team for starts as it always did.
      expect(yield* delivery.prepareThread(threadId("thread-plain"), CLAUDE_HERE)).toBe(false);
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

  it.effect("binds a thread once, with its driver and its repository, and keeps it there", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const id = threadId("thread-bind");
      expect(yield* delivery.threadState(id)).toEqual({ binding: null, pending: null });
      const binding = yield* bind(delivery, id, { cwd: `${REPO}/worktrees/feature` });
      expect([binding.team, binding.role, binding.driver, binding.workspace]).toEqual([
        "development",
        "lead-developer",
        "claudeAgent",
        REPO,
      ]);
      expect(fake.requests[0]?.body).toMatchObject({
        team: "development",
        harness: "claude",
        mode: "chat",
        thread: "thread-bind",
      });
      expect(yield* delivery.threadState(id)).toEqual({ binding, pending: null });

      // Asked again for the same team and harness, the thread keeps the binding it has.
      const sessions = fake.sessions.size;
      expect((yield* bind(delivery, id)).session).toBe(binding.session);
      expect(fake.sessions.size).toBe(sessions);

      // Another team, another role or another harness is another thread.
      for (const other of [{ team: "rnd" }, { role: "qa-attack" }, { driver: "codex" }]) {
        const refused = yield* bind(delivery, id, other).pipe(Effect.flip);
        expect(refused.reason).toBe("refused");
        expect(refused.detail).toContain("Start a new thread");
      }
      expect((yield* delivery.threadState(id)).binding).toEqual(binding);
      const released = yield* delivery.releaseThread(id).pipe(Effect.flip);
      expect(released.detail).toContain("a bound thread keeps its team");
    }).pipe(Effect.provide(layer(fake, { prefix: "t3-delivery-bind-" })));
  });

  it.effect("binds the role the person chose", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const binding = yield* bind(delivery, threadId("thread-role"), { role: "qa-attack" });
      expect(binding.role).toBe("qa-attack");
      expect(fake.requests[0]?.body).toMatchObject({ role: "qa-attack" });
    }).pipe(Effect.provide(layer(fake, { prefix: "t3-delivery-role-" })));
  });

  it.effect("holds a thread whose team setup failed until it is retried or released", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const id = threadId("thread-held");
      fake.down = true;
      const failed = yield* bind(delivery, id, { team: "rnd" }).pipe(Effect.flip);
      expect(failed.reason).toBe("unreachable");

      // The thread is not bound, and it is not free either.
      const state = yield* delivery.threadState(id);
      expect(state.binding).toBeNull();
      expect([state.pending?.team, state.pending?.driver]).toEqual(["rnd", "claudeAgent"]);
      expect(state.pending?.why).toContain("did not answer");
      const start = yield* delivery.prepareThread(id, CLAUDE_HERE).pipe(Effect.flip);
      expect(start.reason).toBe("pending");
      expect(start.detail).toContain("Team rnd was chosen");
      expect(DeliveryThreadSession.readDeliveryThreadSession(id)).toBeUndefined();

      // Retried with the engine back, the thread is bound and starts.
      fake.down = false;
      const binding = yield* bind(delivery, id, { team: "rnd" });
      expect(binding.team).toBe("rnd");
      expect(yield* delivery.threadState(id)).toEqual({ binding, pending: null });
      expect(yield* delivery.prepareThread(id, CLAUDE_HERE)).toBe(true);

      // Released, a held thread starts as an ordinary one. That is a person's choice.
      const other = threadId("thread-released");
      fake.down = true;
      yield* bind(delivery, other).pipe(Effect.flip);
      fake.down = false;
      expect(yield* delivery.releaseThread(other)).toEqual({ binding: null, pending: null });
      expect(yield* delivery.prepareThread(other, CLAUDE_HERE)).toBe(false);
    }).pipe(Effect.provide(layer(fake, { prefix: "t3-delivery-held-" })));
  });

  it.effect("passes on the engine's refusal, and holds the refused thread", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const unknown = yield* bind(delivery, threadId("thread-a"), { team: "sales" }).pipe(
        Effect.flip,
      );
      expect([unknown.reason, unknown.status, unknown.detail]).toEqual([
        "refused",
        404,
        'no team "sales"',
      ]);
      const held = yield* delivery
        .prepareThread(threadId("thread-a"), CLAUDE_HERE)
        .pipe(Effect.flip);
      expect(held.reason).toBe("pending");
      const cursor = yield* bind(delivery, threadId("thread-c"), { driver: "cursor" }).pipe(
        Effect.flip,
      );
      expect(cursor.reason).toBe("unsupportedHarness");
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
        yield* bind(delivery, id);
        expect(yield* DeliveryThreadSession.prepareDeliveryThread(id, CLAUDE_HERE)).toBe(true);

        const instructions = buildRuntimeInstructions({ harness: "Claude Code", threadId: id });
        expect(instructions).toContain(
          '<team_instructions team="development" role="lead-developer" configuration="development@2#0123456789abcdef">',
        );
        expect(instructions).toContain("You are on team development as lead-developer.");
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
        const codexInstructions =
          codex
            .find((value) => value.startsWith("developer_instructions="))
            ?.slice("developer_instructions=".length) ?? "";
        expect(readTomlString(codexInstructions)).toBe(
          DeliveryThreadSession.deliveryInstructions(id),
        );
        expect(readTomlString(codexInstructions)).toContain(
          "You are on team development as lead-developer.\n",
        );
        // Nothing in it that the Windows shell would take as its own.
        expect(codexInstructions.slice(1, -1)).toMatch(/^[A-Za-z0-9 _./:\\-]*$/);
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

  it.effect("refuses a session that is not the one the thread was bound with", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const id = threadId("thread-match");
      yield* bind(delivery, id);
      const start = (actual: { driver: string; cwd: string | undefined }) =>
        delivery.prepareThread(id, actual);

      // The same repository through another of its worktrees, and another spelling of the folder.
      expect(yield* start({ driver: "claudeAgent", cwd: `${REPO}/worktrees/other` })).toBe(true);
      expect(yield* start({ driver: "claudeAgent", cwd: "c:\\WORK\\repo\\" })).toBe(true);

      const harness = yield* start({ driver: "codex", cwd: REPO }).pipe(Effect.flip);
      expect(harness.reason).toBe("mismatch");
      expect(harness.detail).toContain("It cannot continue on codex");
      const workspace = yield* start({ driver: "claudeAgent", cwd: "C:/other" }).pipe(Effect.flip);
      expect(workspace.reason).toBe("mismatch");
      expect(workspace.detail).toContain("another repository");
      const nowhere = yield* start({ driver: "claudeAgent", cwd: undefined }).pipe(Effect.flip);
      expect(nowhere.detail).toContain("no working folder");

      // The engine's setup for the session moved on behind the thread's back.
      fake.tamper = (identity) => ({ ...identity, role: "qa-attack" });
      const role = yield* start(CLAUDE_HERE).pipe(Effect.flip);
      expect(role.reason).toBe("mismatch");
      expect(role.detail).toContain("role is qa-attack, bound as lead-developer");
      fake.tamper = (identity) => ({ ...identity, configuration: "development@3#ffff" });
      expect((yield* start(CLAUDE_HERE).pipe(Effect.flip)).detail).toContain("setup is");

      // After every refusal the adapters have nothing of the team to pass on.
      expect(DeliveryThreadSession.readDeliveryThreadSession(id)).toBeUndefined();
      expect(buildRuntimeInstructions({ harness: "Claude Code", threadId: id })).not.toContain(
        "team_instructions",
      );
      fake.tamper = null;
      expect(yield* start(CLAUDE_HERE)).toBe(true);
    }).pipe(Effect.provide(layer(fake, { prefix: "t3-delivery-match-" })));
  });

  it.effect("does not start a bound thread as an ordinary one when the engine is down", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const delivery = yield* DeliveryService.DeliveryService;
      const id = threadId("thread-down");
      yield* bind(delivery, id);
      fake.down = true;
      const error = yield* DeliveryThreadSession.prepareDeliveryThread(id, CLAUDE_HERE).pipe(
        Effect.flip,
      );
      expect(error.reason).toBe("unreachable");
      // The thread is still bound, and is told so while the engine is away.
      expect((yield* delivery.threadState(id)).binding?.team).toBe("development");
      fake.down = false;
      expect(yield* DeliveryThreadSession.prepareDeliveryThread(id, CLAUDE_HERE)).toBe(true);
    }).pipe(Effect.provide(layer(fake, { prefix: "t3-delivery-down-" })));
  });

  const shared = (prefix: string) =>
    ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provideMerge(NodeServices.layer));

  it.effect("remembers bindings and held threads across a restart", () => {
    const fake = engine();
    const bound = threadId("thread-restart");
    const held = threadId("thread-restart-held");
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const start = <A, E>(body: Effect.Effect<A, E, DeliveryService.DeliveryService>) =>
        body.pipe(Effect.provide(layer(fake, { prefix: "unused-", config })));
      yield* start(
        Effect.gen(function* () {
          const delivery = yield* DeliveryService.DeliveryService;
          yield* bind(delivery, bound, { team: "rnd" });
          fake.down = true;
          yield* bind(delivery, held).pipe(Effect.flip);
          fake.down = false;
        }),
      );
      yield* start(
        Effect.gen(function* () {
          const delivery = yield* DeliveryService.DeliveryService;
          const state = yield* delivery.threadState(bound);
          expect([state.binding?.team, state.binding?.role]).toEqual(["rnd", "lead-developer"]);
          expect(yield* delivery.prepareThread(bound, CLAUDE_HERE)).toBe(true);
          expect((yield* delivery.threadState(held)).pending?.team).toBe("development");
          const refused = yield* delivery.prepareThread(held, CLAUDE_HERE).pipe(Effect.flip);
          expect(refused.reason).toBe("pending");
        }),
      );
    }).pipe(Effect.provide(shared("t3-delivery-restart-")));
  });

  it.effect(
    "holds every thread when the record of bindings is damaged, and leaves the file",
    () => {
      const fake = engine();
      const damaged = '{ "threads": { "thread-x": { "team": ';
      return Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(config.stateDir, "delivery-threads.json");
        yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(file, damaged);
        yield* Effect.gen(function* () {
          const delivery = yield* DeliveryService.DeliveryService;
          // A thread that was bound before the damage must not start as an ordinary one, and
          // which thread that is cannot be known. So none starts.
          const start = yield* delivery
            .prepareThread(threadId("thread-x"), CLAUDE_HERE)
            .pipe(Effect.flip);
          expect(start.reason).toBe("storage");
          expect(start.detail).toContain("is damaged and was left as it is");
          const state = yield* delivery.threadState(threadId("thread-x")).pipe(Effect.flip);
          expect(state.reason).toBe("storage");
          const bound = yield* bind(delivery, threadId("thread-new")).pipe(Effect.flip);
          expect(bound.reason).toBe("storage");
          expect(fake.requests).toEqual([]);
        }).pipe(Effect.provide(layer(fake, { prefix: "unused-", config })));
        expect(yield* fileSystem.readFileString(file)).toBe(damaged);
      }).pipe(Effect.provide(shared("t3-delivery-damaged-")));
    },
  );

  it.effect("holds every thread when the record of bindings cannot be read", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // A folder where the file should be: there, and not readable as a file.
      yield* fileSystem.makeDirectory(path.join(config.stateDir, "delivery-threads.json"), {
        recursive: true,
      });
      yield* Effect.gen(function* () {
        const delivery = yield* DeliveryService.DeliveryService;
        const start = yield* delivery
          .prepareThread(threadId("thread-y"), CLAUDE_HERE)
          .pipe(Effect.flip);
        expect(start.reason).toBe("storage");
        expect(start.detail).toContain("could not be read");
      }).pipe(Effect.provide(layer(fake, { prefix: "unused-", config })));
    }).pipe(Effect.provide(shared("t3-delivery-unreadable-")));
  });

  it.effect("fails the binding when it cannot be saved, and asks nothing of the engine", () => {
    const fake = engine();
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(config.stateDir, "delivery-threads.json");
      yield* Effect.gen(function* () {
        const delivery = yield* DeliveryService.DeliveryService;
        const first = yield* bind(delivery, threadId("thread-saved"));
        // From here on the file cannot be replaced: a folder stands in its place.
        yield* fileSystem.remove(file);
        yield* fileSystem.makeDirectory(path.join(file, "blocker"), { recursive: true });

        const id = threadId("thread-unsaved");
        const failed = yield* bind(delivery, id).pipe(Effect.flip);
        expect(failed.reason).toBe("storage");
        expect(failed.detail).toContain("could not be saved");
        expect(fake.sessions.size).toBe(1);
        expect((yield* delivery.threadState(id)).binding).toBeNull();
        // What was bound before is still bound.
        expect((yield* delivery.threadState(threadId("thread-saved"))).binding).toEqual(first);
      }).pipe(Effect.provide(layer(fake, { prefix: "unused-", config })));
    }).pipe(Effect.provide(shared("t3-delivery-unsaved-")));
  });
});

/** Reads a TOML basic string back, the way Codex does. */
const readTomlString = (value: string) =>
  value
    .slice(1, -1)
    .replace(/\\U([0-9a-f]{8})|\\u([0-9a-f]{4})/g, (_match, long: string, short: string) =>
      String.fromCodePoint(Number.parseInt(long ?? short, 16)),
    );

describe("tomlString", () => {
  it("writes what a shell would misread as escapes, and loses nothing", () => {
    const text = 'Say "no" to <this> & that | 100% of the time ^ \\ path\nnext line é 🙂';
    const written = DeliveryThreadSession.tomlString(text);
    expect(written.slice(1, -1)).toMatch(/^[A-Za-z0-9 _./:\\-]*$/);
    expect(readTomlString(written)).toBe(text);
  });
});

describe("sameFolder", () => {
  it("compares folders as the host does", () => {
    expect(DeliveryService.sameFolder("C:\\Work\\Repo\\", "c:/work/repo", "win32")).toBe(true);
    expect(DeliveryService.sameFolder("/work/Repo", "/work/repo", "linux")).toBe(false);
    expect(DeliveryService.sameFolder("/work/repo/", "/work/repo", "linux")).toBe(true);
    expect(DeliveryService.sameFolder("C:/work/repo", "C:/work/repo2", "win32")).toBe(false);
  });
});
