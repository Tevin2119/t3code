// A scratch engine serving the frozen task-to-thread contract (BOARD-REVAMP-UI-SPEC.md 6a), with
// the shapes of the merged engine half (Operation-PaperClip main at a658892b) and the task claim
// of slice 1. A model, not the engine: BoardTaskThreads.engine.test.ts runs against the real one.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface ScratchLink {
  readonly environmentId: string;
  readonly threadId: string;
  readonly setBy: string;
  readonly setAt: string;
}

export interface ScratchTask {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly team: string;
  readonly set: string | null;
  lane: string;
  state: string;
  submitted: boolean;
  held: boolean;
}

interface Lease {
  readonly holder: string;
  readonly origin: string;
  heartbeat: number;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const ENVIRONMENT_PART = /^[^\s\p{C}/]{1,256}$/u;
const THREAD_PART = /^[^\s\p{C}]{1,1024}$/u;
const LEASE_MS = 120_000;
const CLOSED = ["completed", "closed", "rejected", "cancelled"];

const refused = (status: number, error: string, details: Record<string, unknown> = {}): Answer => ({
  status,
  body: { error, ...details },
});
const sameTarget = (
  a: { environmentId: string; threadId: string } | null,
  b: { environmentId: string; threadId: string } | null,
) => a !== null && b !== null && a.environmentId === b.environmentId && a.threadId === b.threadId;

export function scratchEngine(
  options: {
    readonly key?: string;
    readonly cap?: number;
    /** `false` models an engine before slice 2: no card carries `boardThread`. */
    readonly servesLink?: boolean;
  } = {},
) {
  const key = options.key ?? "scratch approval passphrase";
  const tasks = new Map<string, ScratchTask>();
  const links = new Map<string, ScratchLink>();
  const leases = new Map<string, Lease>();
  const events: Array<{ kind: string; task: string; data: unknown }> = [];
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const sets = new Map<string, { path: string | null }>();
  let teams: unknown = [];
  let clock = Date.parse("2026-11-22T10:00:00.000Z");
  let holderSeq = 0;
  let down = false;
  /** Link writes the engine is answering now, and the most it ever answered at once. */
  const linkWrites = { inFlight: 0, most: 0 };
  /** Runs once, just before the next link write is admitted: another writer getting in first. */
  let beforeNextPut: (() => void) | null = null;

  const live = () => {
    for (const [task, lease] of leases) {
      if (clock - lease.heartbeat > LEASE_MS) leases.delete(task);
    }
    return leases;
  };
  const cardOf = (task: ScratchTask) => ({
    id: task.id,
    number: task.number,
    title: task.title,
    team: task.team,
    set: task.set,
    lane: task.lane,
    state: task.state,
    submitted: task.submitted ? "2026-11-22T09:00:00.000Z" : null,
    held: task.held,
    ...(options.servesLink === false ? {} : { boardThread: links.get(task.id) ?? null }),
  });

  const putLink = (id: string, body: Record<string, unknown>): Answer => {
    const task = tasks.get(id);
    if (!task) return refused(404, `no task ${id.slice(0, 40)}`, { code: "not-found", task: null });
    const invalid = (field: string, error: string) =>
      refused(400, error, { code: "invalid-field", field });
    const { environmentId, threadId, setBy, expect } = body;
    if (typeof environmentId !== "string" || !ENVIRONMENT_PART.test(environmentId))
      return invalid(
        "environmentId",
        "environmentId is 1-256 characters without whitespace, control characters or /",
      );
    if (typeof threadId !== "string" || !THREAD_PART.test(threadId))
      return invalid(
        "threadId",
        "threadId is 1-1024 characters without whitespace or control characters; / : and % are allowed",
      );
    if (typeof setBy !== "string" || !ENVIRONMENT_PART.test(setBy))
      return invalid("setBy", "setBy names the T3 environment that writes the link");
    let believed: { environmentId: string; threadId: string } | null = null;
    const expectsNone = expect === null;
    if (expect !== undefined && !expectsNone) {
      const value = expect as Record<string, unknown>;
      if (
        typeof expect !== "object" ||
        Array.isArray(expect) ||
        typeof value.environmentId !== "string" ||
        typeof value.threadId !== "string"
      )
        return invalid(
          "expect",
          "expect is the link believed current: null, or { environmentId, threadId }",
        );
      believed = { environmentId: value.environmentId, threadId: value.threadId };
    }
    const previous = links.get(id) ?? null;
    if (expectsNone && previous)
      return refused(409, "a board thread is set; the caller believed none was", {
        code: "conflict",
        current: previous,
        expect: null,
      });
    if (believed && !sameTarget(believed, previous))
      return refused(409, "the board thread changed since the caller read it", {
        code: "conflict",
        current: previous,
        expect: believed,
      });
    if (previous && sameTarget(previous, { environmentId, threadId }))
      return {
        status: 200,
        body: { task: id, number: task.number, boardThread: previous, unchanged: true },
      };
    const boardThread = {
      environmentId,
      threadId,
      setBy,
      setAt: DateTime.formatIso(DateTime.makeUnsafe(clock)),
    };
    links.set(id, boardThread);
    events.push({ kind: "task.board-thread-set", task: id, data: { previous, boardThread } });
    return { status: 200, body: { task: id, number: task.number, boardThread } };
  };

  const clearLink = (id: string): Answer => {
    if (!tasks.has(id))
      return refused(404, `no task ${id.slice(0, 40)}`, { code: "not-found", task: null });
    const previous = links.get(id) ?? null;
    if (previous) {
      links.delete(id);
      events.push({ kind: "task.board-thread-cleared", task: id, data: { previous } });
    }
    return { status: 204, body: null };
  };

  const claim = (id: string, body: Record<string, unknown>): Answer => {
    const task = tasks.get(id);
    if (!task) return refused(404, "no such task");
    if (typeof body.origin !== "string" || !body.origin.trim())
      return refused(400, "name the thread origin the claim is made from");
    if (!task.submitted)
      return refused(409, `#${task.number} is not submitted; only submitted work is claimed`);
    if (task.state === "moving" || task.state === "moved")
      return refused(409, `#${task.number} moved to another machine; it is claimed there`);
    if (CLOSED.includes(task.state))
      return refused(409, `#${task.number} is ${task.state}; finished work is not claimed`);
    if (task.held) return refused(409, `#${task.number} is paused; resume it before it is claimed`);
    const held = live().get(id);
    if (held) return refused(409, `#${task.number} is already claimed by ${held.origin}`);
    const cap = options.cap ?? 4;
    if (live().size >= cap)
      return refused(409, `the task cap is reached: ${live().size} of ${cap} slots are taken`);
    const lease = { holder: `holder-${++holderSeq}`, origin: body.origin.trim(), heartbeat: clock };
    leases.set(id, lease);
    events.push({ kind: "orchestration.claimed", task: id, data: { origin: lease.origin } });
    return {
      status: 200,
      body: { claimed: true, task: id, holder: lease.holder, origin: lease.origin },
    };
  };
  const withLease = (
    id: string,
    body: Record<string, unknown>,
    then: (lease: Lease) => Answer,
  ): Answer => {
    const task = tasks.get(id);
    if (!task) return refused(404, "no such task");
    const lease = live().get(id);
    if (!lease) return refused(404, `no live lease holds #${task.number}`);
    if (body.holder !== lease.holder) return refused(409, "the lease holder does not match");
    return then(lease);
  };

  const handle = (method: string, pathname: string, raw: unknown): Answer => {
    const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    requests.push({ method, path: pathname, body: raw });
    if (method === "GET" && pathname === "/api/lanes") {
      // A task that moved away has no lane and is on no board; one on its way keeps its lane.
      const cards = [...tasks.values()].filter((task) => task.state !== "moved").map(cardOf);
      return {
        status: 200,
        body: {
          lanes: [...new Set(cards.map((card) => card.lane))].map((lane) => ({
            lane,
            title: lane,
            cards: cards.filter((card) => card.lane === lane),
          })),
          sets: [...sets].map(([id, target]) => ({ id, target })),
        },
      };
    }
    if (method === "GET" && pathname === "/api/teams") return { status: 200, body: teams };
    const detail = /^\/api\/tasks\/([\w-]+)$/.exec(pathname);
    if (method === "GET" && detail) {
      const task = tasks.get(detail[1]!);
      // `thread` keeps meaning the task id; the conversation is only ever `boardThread`. A moved
      // task is still answered for, with its state and no lane.
      return task
        ? {
            status: 200,
            body: {
              ...cardOf(task),
              ...(task.state === "moved" ? { lane: null } : {}),
              thread: task.id,
              source: null,
            },
          }
        : refused(404, `no task ${detail[1]}`);
    }
    // The moved guard of every task write, which runs before the key is looked at.
    const touched =
      method !== "GET" ? /^\/api\/(tasks|runs|threads)\/([\w-]+)\/(?!moved$)/.exec(pathname) : null;
    const guarded = touched ? tasks.get(touched[2]!) : undefined;
    if (guarded?.state === "moving")
      return refused(
        409,
        `#${guarded.number} is on its way to another machine; it takes no work until that is settled`,
        { code: "moved" },
      );
    if (guarded?.state === "moved")
      return refused(409, `#${guarded.number} moved to another machine; it is worked there now`, {
        code: "moved",
      });
    const link = /^\/api\/tasks\/([\w-]+)\/board-thread$/.exec(pathname);
    if (link && (method === "PUT" || method === "DELETE")) {
      if (body.key !== key)
        return refused(403, "the approval key is wrong or missing", { code: "refused" });
      if (method === "DELETE") return clearLink(link[1]!);
      const before = beforeNextPut;
      beforeNextPut = null;
      before?.();
      return putLink(link[1]!, body);
    }
    const lease = /^\/api\/orchestration\/tasks\/([\w-]+)\/(claim|ack|release)$/.exec(pathname);
    if (lease && method === "POST") {
      const id = lease[1]!;
      if (lease[2] === "claim") return claim(id, body);
      if (lease[2] === "ack")
        return withLease(id, body, (held) => {
          held.heartbeat = clock;
          return { status: 200, body: { renewed: true, task: id } };
        });
      return withLease(id, body, () => {
        leases.delete(id);
        return { status: 200, body: { released: true, task: id } };
      });
    }
    return refused(404, `no route ${method} ${pathname}`);
  };

  return {
    key,
    events,
    requests,
    handle,
    addTask(task: Partial<ScratchTask> & Pick<ScratchTask, "id">) {
      const added: ScratchTask = {
        number: 1000 + tasks.size,
        title: `Task ${task.id}`,
        team: "development",
        set: "work",
        lane: "implementation",
        state: "running",
        submitted: true,
        held: false,
        ...task,
      };
      tasks.set(added.id, added);
      return added;
    },
    task: (id: string) => tasks.get(id)!,
    removeTask: (id: string) => {
      tasks.delete(id);
      links.delete(id);
      leases.delete(id);
    },
    setBoard: (id: string, path: string | null) => sets.set(id, { path }),
    setTeams: (value: unknown) => {
      teams = value;
    },
    linkOf: (id: string) => links.get(id) ?? null,
    /** Another writer's link, written as the engine would write it. */
    writeLink: (id: string, link: { environmentId: string; threadId: string; setBy: string }) =>
      putLink(id, link),
    leaseOf: (id: string) => live().get(id) ?? null,
    advance: (ms: number) => {
      clock += ms;
    },
    beforeNextPut: (run: () => void) => {
      beforeNextPut = run;
    },
    setDown: (value: boolean) => {
      down = value;
    },
    isDown: () => down,
    linkWrites,
  };
}

export type ScratchEngine = ReturnType<typeof scratchEngine>;

/** The scratch engine behind the HTTP client the delivery service uses for the real one. */
export const scratchEngineHttp = (engine: ScratchEngine) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        if (engine.isDown()) return Effect.fail(new Error("connection refused") as never);
        const url = new URL(request.url);
        const body =
          request.body._tag === "Uint8Array"
            ? decodeJson(new TextDecoder().decode(request.body.body))
            : undefined;
        const answer = () => {
          const { status, body: answered } = engine.handle(request.method, url.pathname, body);
          return HttpClientResponse.fromWeb(
            request,
            status === 204
              ? new Response(null, { status: 204 })
              : Response.json(answered, { status }),
          );
        };
        if (request.method !== "PUT") return Effect.sync(answer);
        // A link write takes a turn of the scheduler, so two sent at once would be seen together.
        engine.linkWrites.inFlight += 1;
        engine.linkWrites.most = Math.max(engine.linkWrites.most, engine.linkWrites.inFlight);
        return Effect.yieldNow.pipe(
          Effect.map(answer),
          Effect.ensuring(
            Effect.sync(() => {
              engine.linkWrites.inFlight -= 1;
            }),
          ),
        );
      }),
    ),
  );
