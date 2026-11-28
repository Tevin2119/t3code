import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/**
 * The engine's board and task routes as `BoardAgentTools` uses them (Operation-PaperClip
 * `delivery/lib/api.mjs`, `desk.mjs` and `sets.mjs` at f0479dd8), kept in memory. It answers
 * what the engine answers and refuses what it refuses, with its words where a tool shows them.
 */
export interface AgentEngineTask {
  id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  lane: string;
  set: string | null;
  team: string;
  origin: string;
  updated: string;
  held: boolean;
  run: { id: string; state: string; stage: string | null } | null;
  repository: string | null;
  deployment: unknown;
}

interface Board {
  title: string;
  description: string;
  icon?: string;
  repository: string | null;
  base: string | null;
  deploymentProjectId: string | null;
}

const MACHINE = /^(engine|seat|agent|model)(?!\p{L})/iu;

export function agentEngine() {
  const repositories = new Map<string, string>([["app", "App"]]);
  const boards = new Map<string, Board>();
  const tasks = new Map<string, AgentEngineTask>();
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const KEY = "engine approval passphrase";
  let clock = Date.parse("2026-11-28T10:00:00.000Z");
  let numbers = 0;
  const tick = () => DateTime.formatIso(DateTime.makeUnsafe((clock += 1_000)));

  const refuse = (status: number, error: string) => ({ status, body: { error } });
  const cardOf = (task: AgentEngineTask) => ({
    id: task.id,
    number: task.number,
    title: task.title,
    state: task.state,
    lane: task.lane,
    set: task.set,
    team: task.team,
    origin: task.origin,
    updated: task.updated,
    held: task.held,
    run: task.run,
    workers: task.run?.state === "running" ? [{ seat: "developer" }] : [],
    deployment: task.deployment,
    target: { repository: task.repository },
  });
  const boardView = (id: string, board: Board) => ({
    id,
    title: board.title,
    ...(board.icon ? { icon: board.icon } : {}),
    description: board.description,
    target: { repository: board.repository, base: board.base },
    deploymentProjectId: board.deploymentProjectId,
    deployment: null,
  });
  const change = (task: AgentEngineTask, fields: Partial<AgentEngineTask>) =>
    Object.assign(task, fields, { updated: tick() });

  const handle = (
    method: string,
    path: string,
    body: Record<string, unknown>,
    query: URLSearchParams,
  ): { status: number; body: unknown } => {
    if (method === "POST") {
      if (typeof body.by === "string" && MACHINE.test(body.by.trim()))
        return refuse(400, "That name is used by the engine. Sign with your own name.");
      writes.push({ path, body });
    }
    if (method === "POST" && path === "/api/engine/lifecycle") {
      if (body.key !== KEY) return refuse(403, "the approval key is wrong or missing");
      return {
        status: 200,
        body: { accepted: true, id: "5f0c2b8e-0d7e-4f61-9d1e-2a4b6c8d0e1f", action: body.action },
      };
    }
    if (method === "GET" && path === "/api/boards")
      return { status: 200, body: [...boards].map(([id, board]) => boardView(id, board)) };
    if (method === "GET" && path === "/api/repositories")
      return {
        status: 200,
        body: [
          ...[...repositories].map(([id, title]) => ({ id, title, kind: "own" })),
          { id: "qualification", title: "Qualification repository", kind: "qualification" },
        ],
      };
    if (method === "POST" && path === "/api/boards") {
      const repository = String(body.repository ?? "");
      if (!repositories.has(repository)) return refuse(400, `no repository ${repository}`);
      const id = String(body.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-");
      const board: Board = {
        title: String(body.title),
        description: String(body.description ?? ""),
        repository,
        base: (body.base as string | null) ?? null,
        deploymentProjectId: null,
      };
      boards.set(id, board);
      return { status: 200, body: { id, ...board } };
    }
    const boardRoute = /^\/api\/boards\/([\w-]+)\/(edit|remove)$/.exec(path);
    if (method === "POST" && boardRoute) {
      const [, id, action] = boardRoute;
      const board = boards.get(id!);
      if (!board) return refuse(400, `no board of your own named ${id}`);
      if (action === "remove") {
        boards.delete(id!);
        let kept = 0;
        for (const task of tasks.values())
          if (task.set === id) {
            kept += 1;
            change(task, { set: null });
          }
        return { status: 200, body: { removed: id, tasksKept: kept } };
      }
      if (body.title !== undefined) board.title = String(body.title);
      if (body.description !== undefined) board.description = String(body.description);
      if (body.repository !== undefined) board.repository = String(body.repository);
      return { status: 200, body: { id, ...board } };
    }
    if (method === "GET" && path === "/api/tasks") {
      const set = query.get("set") ?? "unsorted";
      const lane = query.get("lane");
      const origin = query.get("origin");
      const words = (query.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const limit = Math.min(500, Number(query.get("limit")) || 200);
      const found = [...tasks.values()]
        .filter((task) =>
          origin
            ? task.origin === origin
            : (set === "all" || task.set === set) &&
              (!lane || task.lane === lane) &&
              words.every((word) => `${task.title} ${task.body}`.toLowerCase().includes(word)),
        )
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, limit)
        .map(cardOf);
      return { status: 200, body: found };
    }
    const taskRoute = /^\/api\/tasks\/([\w-]+)(?:\/([\w-]+))?$/.exec(path);
    const task = taskRoute ? tasks.get(taskRoute[1]!) : undefined;
    if (taskRoute && !task) return refuse(404, `no task ${taskRoute[1]}`);
    if (!task) return refuse(404, "not found");
    const action = taskRoute?.[2];
    if (method === "GET" && action === undefined)
      return { status: 200, body: { ...cardOf(task), body: task.body } };
    if (method !== "POST") return refuse(404, "not found");
    switch (action) {
      case "edit": {
        if (task.state !== "draft" && body.body !== undefined)
          return refuse(
            409,
            "this task has been submitted. What is asked is changed by a change on the task, which makes a new revision.",
          );
        change(task, {
          ...(body.title === undefined ? {} : { title: String(body.title) }),
          ...(body.body === undefined ? {} : { body: String(body.body) }),
        });
        return { status: 200, body: cardOf(task) };
      }
      case "submit":
        if (task.state !== "draft") return refuse(409, "this task has already been submitted");
        change(task, { state: "ready", lane: "queue" });
        return { status: 200, body: cardOf(task) };
      case "move": {
        const to = String(body.lane);
        if (["closed", "rejected", "merged"].includes(task.state))
          return refuse(
            409,
            "This task is closed. What was said and found is kept; a new task starts the work again.",
          );
        if (to === "paused") change(task, { held: true, lane: "paused" });
        else if (to === "queue" && task.state === "draft")
          change(task, { state: "ready", lane: "queue" });
        else
          return refuse(409, `The engine puts a card in "${to}" when its work reaches that stage.`);
        return { status: 200, body: cardOf(task) };
      }
      case "board": {
        const board = (body.board as string | null) ?? null;
        if (board !== null && !boards.has(board))
          return refuse(400, `no board of your own named ${board}`);
        change(task, { set: board });
        return { status: 200, body: { task: task.id, board: board ?? "unsorted" } };
      }
      case "relocate": {
        const board = boards.get(String(body.board));
        if (!board) return refuse(400, `no board of your own named ${String(body.board)}`);
        change(task, {
          set: String(body.board),
          repository: board.repository,
          state: task.state === "draft" ? "draft" : "triage",
        });
        return { status: 200, body: cardOf(task) };
      }
      case "control": {
        if (body.action !== "close") return refuse(400, "a control is one of: close");
        if (task.state === "draft") return refuse(409, "this task has not been submitted");
        if (task.state === "closed") return refuse(409, "this task is closed already.");
        if (!String(body.reason ?? "").trim())
          return refuse(
            400,
            "a close needs a reason: say why the task is closed without being done.",
          );
        change(task, {
          state: "closed",
          lane: "closed-not-done",
          held: false,
          run: task.run && { ...task.run, state: "closed" },
        });
        return { status: 200, body: cardOf(task) };
      }
      case "discard":
        if (task.state !== "draft")
          return refuse(
            409,
            "a task that was submitted is kept as a record and cannot be discarded",
          );
        tasks.delete(task.id);
        return { status: 200, body: { discarded: task.id } };
      default:
        return refuse(404, "not found");
    }
  };

  return {
    key: KEY,
    handle,
    writes,
    tasks,
    addBoard: (id: string, board: Partial<Board> = {}) =>
      void boards.set(id, {
        title: id,
        description: "",
        repository: "app",
        base: "main",
        deploymentProjectId: null,
        ...board,
      }),
    addRepository: (id: string) => void repositories.set(id, id),
    addTask: (fields: Partial<AgentEngineTask> = {}) => {
      numbers += 1;
      const task: AgentEngineTask = {
        id: `task-${numbers}`,
        number: numbers,
        title: `Task ${numbers}`,
        body: "Do the thing.",
        state: "ready",
        lane: "queue",
        set: "work",
        team: "default",
        origin: "person",
        updated: tick(),
        held: false,
        run: null,
        repository: "app",
        deployment: null,
        ...fields,
      };
      tasks.set(task.id, task);
      return task;
    },
    touch: (id: string) => {
      const task = tasks.get(id);
      if (task) change(task, {});
    },
  };
}
export type AgentEngine = ReturnType<typeof agentEngine>;

/** The engine behind the HTTP client the delivery service uses for the real one. */
export const agentEngineHttp = (engine: AgentEngine) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        const body =
          request.body._tag === "Uint8Array"
            ? (decodeJson(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
            : {};
        const answer = engine.handle(request.method, url.pathname, body, url.searchParams);
        return HttpClientResponse.fromWeb(
          request,
          Response.json(answer.body, { status: answer.status }),
        );
      }),
    ),
  );
