import {
  BOARD_AGENT_BULK_MAX,
  DeliveryEngineLifecycleReceipt,
  DeliveryError,
  OrchestratorMcpFailure,
  isReservedBoardTaskBoard,
  type BoardAgentBoard,
  type BoardAgentBoardCreateInput,
  type BoardAgentBoardEditInput,
  type BoardAgentBoardRemoveInput,
  type BoardAgentBoardsResult,
  type BoardAgentBulkCloseInput,
  type BoardAgentBulkMoveInput,
  type BoardAgentBulkResult,
  type BoardAgentTask,
  type BoardAgentTaskCloseInput,
  type BoardAgentTaskDiscardInput,
  type BoardAgentTaskEditInput,
  type BoardAgentTaskFilter,
  type BoardAgentTaskMoveInput,
  type BoardAgentTaskRef,
  type BoardAgentTaskSummary,
  type BoardAgentTasksListInput,
  type BoardAgentTasksListResult,
  type BoardAgentBoardToolInput,
  type BoardAgentBoardToolResult,
  type BoardAgentTaskToolInput,
  type BoardAgentTasksToolInput,
  type BoardAgentTasksToolResult,
  type DeliveryEngineLifecycleInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Delivery from "./DeliveryService.ts";

const { readOrNull } = Delivery;

const Card = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  lane: readOrNull(Schema.String),
  set: readOrNull(Schema.String),
  team: readOrNull(Schema.String),
  origin: readOrNull(Schema.String),
  updated: readOrNull(Schema.String),
  held: readOrNull(Schema.Boolean),
  run: readOrNull(
    Schema.Struct({ id: Schema.String, state: Schema.String, stage: readOrNull(Schema.String) }),
  ),
  workers: readOrNull(Schema.Array(Schema.Unknown)),
  deployment: Schema.optional(Schema.Unknown),
  target: readOrNull(Schema.Struct({ repository: readOrNull(Schema.String) })),
  body: readOrNull(Schema.String),
});
type Card = typeof Card.Type;
const decodeCard = Schema.decodeUnknownEffect(Card);
const decodeCards = Schema.decodeUnknownEffect(Schema.Array(Card));
const decodeBoards = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      description: readOrNull(Schema.String),
      icon: readOrNull(Schema.String),
      target: readOrNull(
        Schema.Struct({ repository: readOrNull(Schema.String), base: readOrNull(Schema.String) }),
      ),
      deploymentProjectId: readOrNull(Schema.String),
    }),
  ),
);
const decodeRepositories = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: readOrNull(Schema.String),
      kind: readOrNull(Schema.String),
    }),
  ),
);
const decodeRemoved = Schema.decodeUnknownEffect(Schema.Struct({ removed: Schema.String }));
const decodeDiscarded = Schema.decodeUnknownEffect(Schema.Struct({ discarded: Schema.String }));
const decodeLifecycle = Schema.decodeUnknownEffect(DeliveryEngineLifecycleReceipt);

/** The engine's own cap on one task search. */
const SEARCH_MAX = 500;
/** States in which a close has nothing left to end. */
const ENDED = ["closed", "rejected", "merged", "moved", "moving"];
const LIVE_RUN = ["admitted", "running"];

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const incompatible = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The delivery engine answered in a shape this T3 does not read. Update the engine.",
  });

function engineFailure(error: DeliveryError): OrchestratorMcpFailure {
  switch (error.reason) {
    case "refused":
    case "invalid":
      return invalid(error.detail);
    case "disabled":
      return new OrchestratorMcpFailure({ code: "unsupported", message: error.detail });
    default:
      return new OrchestratorMcpFailure({ code: "orchestration_error", message: error.detail });
  }
}

/**
 * Who the engine records for an agent's change: the calling thread, or the outside client.
 * The engine refuses names that start like a machine's ("agent", "seat"), so it starts "T3".
 */
export function actorOf(scope: McpInvocationScope): string {
  const sender = scope.client?.senderThread;
  const name =
    scope.thread !== undefined
      ? `T3 thread ${scope.thread.threadId}`
      : sender !== undefined
        ? `T3 thread ${sender.threadId} (linked)`
        : `T3 client ${scope.client?.label ?? "unknown"}`;
  return name.replace(/\s+/g, " ").slice(0, 60);
}

const summaryOf = (card: Card, deploymentBoards: ReadonlySet<string>): BoardAgentTaskSummary => ({
  id: card.id,
  number: card.number,
  title: card.title,
  state: card.state,
  lane: card.lane ?? null,
  board: card.set ?? null,
  team: card.team ?? null,
  origin: card.origin ?? null,
  updated: card.updated ?? null,
  held: card.held === true,
  run: card.run ? { id: card.run.id, state: card.run.state, stage: card.run.stage ?? null } : null,
  live: (card.run != null && LIVE_RUN.includes(card.run.state)) || (card.workers ?? []).length > 0,
  deploymentLinked:
    (card.deployment !== undefined && card.deployment !== null) ||
    (card.set != null && deploymentBoards.has(card.set)),
});

const matches = (filter: BoardAgentTaskFilter) => (task: BoardAgentTaskSummary) =>
  (filter.board === undefined || task.board === filter.board) &&
  (filter.state === undefined || task.state === filter.state) &&
  (filter.updatedBefore === undefined ||
    (task.updated !== null && task.updated < filter.updatedBefore));

/** Why a guarded change is refused without `force`, or null. */
const guardOf = (task: BoardAgentTaskSummary, force: boolean | undefined) =>
  force === true
    ? null
    : task.live
      ? `#${task.number} has a live run. Pass force only when the person asked to stop it.`
      : task.deploymentLinked
        ? `#${task.number} is on a deployment-linked board. Pass force only when the person asked.`
        : null;

const sha256 = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) => Hex.encode(new Uint8Array(digest))),
  );

export class BoardAgentTools extends Context.Service<
  BoardAgentTools,
  {
    readonly listBoards: Effect.Effect<BoardAgentBoardsResult, OrchestratorMcpFailure>;
    readonly createBoard: (
      scope: McpInvocationScope,
      input: BoardAgentBoardCreateInput,
    ) => Effect.Effect<BoardAgentBoard, OrchestratorMcpFailure>;
    readonly editBoard: (
      scope: McpInvocationScope,
      input: BoardAgentBoardEditInput,
    ) => Effect.Effect<BoardAgentBoard, OrchestratorMcpFailure>;
    /** Keeps the board's tasks, on no board. The engine has no restore. */
    readonly removeBoard: (
      scope: McpInvocationScope,
      input: BoardAgentBoardRemoveInput,
    ) => Effect.Effect<
      { removed: string; tasks: ReadonlyArray<string>; board: BoardAgentBoard },
      OrchestratorMcpFailure
    >;
    readonly listTasks: (
      input: BoardAgentTasksListInput,
    ) => Effect.Effect<BoardAgentTasksListResult, OrchestratorMcpFailure>;
    readonly getTask: (
      input: BoardAgentTaskRef,
    ) => Effect.Effect<BoardAgentTask, OrchestratorMcpFailure>;
    readonly editTask: (
      scope: McpInvocationScope,
      input: BoardAgentTaskEditInput,
    ) => Effect.Effect<BoardAgentTask, OrchestratorMcpFailure>;
    readonly moveTask: (
      scope: McpInvocationScope,
      input: BoardAgentTaskMoveInput,
    ) => Effect.Effect<BoardAgentTask, OrchestratorMcpFailure>;
    readonly submitTask: (
      scope: McpInvocationScope,
      input: BoardAgentTaskRef,
    ) => Effect.Effect<BoardAgentTask, OrchestratorMcpFailure>;
    /** The engine has no reopen: a closed task stays closed. */
    readonly closeTask: (
      scope: McpInvocationScope,
      input: BoardAgentTaskCloseInput,
    ) => Effect.Effect<BoardAgentTask, OrchestratorMcpFailure>;
    readonly discardTask: (
      scope: McpInvocationScope,
      input: BoardAgentTaskDiscardInput,
    ) => Effect.Effect<{ discarded: string }, OrchestratorMcpFailure>;
    /** A dry run unless confirmed with the token of a dry run of the same list. */
    readonly closeTasks: (
      scope: McpInvocationScope,
      input: BoardAgentBulkCloseInput,
    ) => Effect.Effect<BoardAgentBulkResult, OrchestratorMcpFailure>;
    readonly moveTasks: (
      scope: McpInvocationScope,
      input: BoardAgentBulkMoveInput,
    ) => Effect.Effect<BoardAgentBulkResult, OrchestratorMcpFailure>;
    /**
     * Stops or restarts the engine through its launcher with the approval key saved on this
     * server. The key goes only to the engine; with none saved, nothing is sent.
     */
    readonly engineLifecycle: (
      input: DeliveryEngineLifecycleInput,
    ) => Effect.Effect<typeof DeliveryEngineLifecycleReceipt.Type, DeliveryError>;
    /** The `delivery_board`, `delivery_task` and `delivery_tasks` tools: one action each call. */
    readonly board: (
      scope: McpInvocationScope,
      input: BoardAgentBoardToolInput,
    ) => Effect.Effect<BoardAgentBoardToolResult, OrchestratorMcpFailure>;
    readonly task: (
      scope: McpInvocationScope,
      input: BoardAgentTaskToolInput,
    ) => Effect.Effect<BoardAgentTask, OrchestratorMcpFailure>;
    readonly tasks: (
      scope: McpInvocationScope,
      input: BoardAgentTasksToolInput,
    ) => Effect.Effect<BoardAgentTasksToolResult, OrchestratorMcpFailure>;
  }
>()("t3/delivery/BoardAgentTools") {}

type Actions = Omit<BoardAgentTools["Service"], "board" | "task" | "tasks">;

const needs = <A>(value: A | undefined, what: string) =>
  value === undefined
    ? Effect.fail(invalid(`This action needs \`${what}\`.`))
    : Effect.succeed(value);

/** Each folded tool's action, as the one method it stands for. */
const folded = (
  actions: Actions,
): Pick<BoardAgentTools["Service"], "board" | "task" | "tasks"> => ({
  board: Effect.fn("BoardAgentTools.board")(function* (scope, input) {
    const { action, board, title, repository, force, ...fields } = input;
    switch (action) {
      case "list":
        return yield* actions.listBoards;
      case "create": {
        const created = yield* actions.createBoard(scope, {
          ...fields,
          title: yield* needs(title, "title"),
          repository: yield* needs(repository, "repository"),
        });
        return { boards: [created] };
      }
      case "edit": {
        const edited = yield* actions.editBoard(scope, {
          ...fields,
          board: yield* needs(board, "board"),
          title,
          repository,
        });
        return { boards: [edited] };
      }
      case "remove": {
        const removed = yield* actions.removeBoard(scope, {
          board: yield* needs(board, "board"),
          force,
        });
        return { boards: [removed.board], tasks: removed.tasks };
      }
    }
  }),
  task: Effect.fn("BoardAgentTools.task")(function* (scope, input) {
    const { action, task, title, body, priority, tags, lane, board, base, reason, force } = input;
    switch (action) {
      case "get":
        return yield* actions.getTask({ task });
      case "edit":
        return yield* actions.editTask(scope, { task, title, body, priority, tags });
      case "move":
        return yield* actions.moveTask(scope, { task, lane, board, base, force });
      case "submit":
        return yield* actions.submitTask(scope, { task });
      case "close":
        return yield* actions.closeTask(scope, {
          task,
          reason: yield* needs(reason, "reason"),
          force,
        });
      case "discard": {
        const before = yield* actions.getTask({ task });
        yield* actions.discardTask(scope, { task, force });
        return { ...before, state: "discarded", lane: null, live: false };
      }
    }
  }),
  tasks: Effect.fn("BoardAgentTools.tasks")(function* (scope, input) {
    const { action, filter, tasks, limit, reason, lane, board, force, confirm, dryRunToken } =
      input;
    if (action === "list") return yield* actions.listTasks({ ...filter, limit });
    const selection = { tasks, filter, force, confirm, dryRunToken };
    const result =
      action === "close"
        ? yield* actions.closeTasks(scope, { ...selection, reason: yield* needs(reason, "reason") })
        : yield* actions.moveTasks(scope, { ...selection, lane, board });
    return { more: result.more, dryRunToken: result.dryRunToken, items: result.items };
  }),
});

const make = Effect.gen(function* () {
  const delivery = yield* Delivery.DeliveryService;
  // Tokens are this server's word for one previewed list; a restart asks for a new dry run.
  const secret = yield* (yield* SecureRandom.SecureRandom).uuidV4().pipe(Effect.orDie);

  const get = <A, E>(path: string, decode: (body: unknown) => Effect.Effect<A, E>) =>
    delivery.read({ path }).pipe(
      Effect.mapError(engineFailure),
      Effect.flatMap((response) => decode(response.body).pipe(Effect.mapError(incompatible))),
    );
  const post = <A, E>(
    path: string,
    body: Record<string, unknown>,
    decode: (body: unknown) => Effect.Effect<A, E>,
  ) =>
    delivery.act({ path, body }).pipe(
      Effect.mapError(engineFailure),
      Effect.flatMap((response) => decode(response.body).pipe(Effect.mapError(incompatible))),
    );

  const rawBoards = get("/api/boards", decodeBoards);
  const boardOf = (board: Effect.Success<typeof rawBoards>[number]): BoardAgentBoard => ({
    id: board.id,
    title: board.title,
    description: board.description ?? "",
    icon: board.icon ?? null,
    repository: board.target?.repository ?? null,
    base: board.target?.base ?? null,
    deploymentLinked: board.deploymentProjectId != null,
  });
  const boards = rawBoards.pipe(Effect.map((all) => all.map(boardOf)));
  const deploymentBoards = boards.pipe(
    Effect.map((all) => new Set(all.filter((board) => board.deploymentLinked).map((b) => b.id))),
  );
  const boardNamed = Effect.fn("BoardAgentTools.boardNamed")(function* (id: string) {
    const found = (yield* boards).find((board) => board.id === id);
    if (found === undefined)
      return yield* invalid(`No board ${id}. List them with the delivery_board list action.`);
    return found;
  });

  const taskOf = Effect.fn("BoardAgentTools.taskOf")(function* (id: string) {
    const card = yield* get(`/api/tasks/${encodeURIComponent(id)}`, decodeCard);
    return { card, summary: summaryOf(card, yield* deploymentBoards) };
  });
  const detailOf = (card: Card, summary: BoardAgentTaskSummary): BoardAgentTask => ({
    ...summary,
    body: card.body ?? null,
  });
  const reread = (id: string) =>
    taskOf(id).pipe(Effect.map(({ card, summary }) => detailOf(card, summary)));

  const search = Effect.fn("BoardAgentTools.search")(function* (
    filter: BoardAgentTaskFilter,
    limit: number,
  ) {
    const params = new URLSearchParams({ set: filter.board ?? "all", limit: String(SEARCH_MAX) });
    if (filter.query !== undefined) params.set("q", filter.query);
    if (filter.lane !== undefined) params.set("lane", filter.lane);
    if (filter.origin !== undefined) params.set("origin", filter.origin);
    const cards = yield* get(`/api/tasks?${params.toString()}`, decodeCards);
    const shown = yield* deploymentBoards;
    const found = cards.map((card) => summaryOf(card, shown)).filter(matches(filter));
    // A full engine page may hide older matches the client-side filters would keep.
    return {
      tasks: found.slice(0, limit),
      more: found.length > limit || cards.length >= SEARCH_MAX,
    };
  });

  const listTasks = Effect.fn("BoardAgentTools.listTasks")(function* (
    input: BoardAgentTasksListInput,
  ) {
    const { limit, ...filter } = input;
    return yield* search(filter, limit ?? 100);
  });

  const placeOnBoard = Effect.fn("BoardAgentTools.placeOnBoard")(function* (
    by: string,
    task: { card: Card; summary: BoardAgentTaskSummary },
    board: string | null,
    base: string | undefined,
  ) {
    const id = encodeURIComponent(task.card.id);
    if (board === null)
      return yield* post(`/api/tasks/${id}/board`, { board: null, by }, Effect.succeed);
    if (isReservedBoardTaskBoard(board)) return yield* invalid("Choose a custom board.");
    const target = yield* boardNamed(board);
    if (base !== undefined)
      return yield* post(`/api/tasks/${id}/relocate`, { board, base, by }, Effect.succeed);
    const from = task.card.target?.repository ?? null;
    // As the board's Move: a board done in another repository moves the work, which needs a base.
    if (from !== null && target.repository !== null && from !== target.repository)
      return yield* invalid(
        `Board ${board} works in ${target.repository}, not ${from}. Pass \`base\` to move the work there; it goes to triage again.`,
      );
    return yield* post(`/api/tasks/${id}/board`, { board, by }, Effect.succeed);
  });

  const move = Effect.fn("BoardAgentTools.move")(function* (
    by: string,
    task: { card: Card; summary: BoardAgentTaskSummary },
    input: {
      lane?: string | undefined;
      board?: string | null | undefined;
      base?: string | undefined;
    },
  ) {
    if (input.board !== undefined) yield* placeOnBoard(by, task, input.board, input.base);
    if (input.lane !== undefined)
      yield* post(
        `/api/tasks/${encodeURIComponent(task.card.id)}/move`,
        { lane: input.lane, by },
        Effect.succeed,
      );
  });

  const closeOne = (by: string, id: string, reason: string) =>
    post(
      `/api/tasks/${encodeURIComponent(id)}/control`,
      { action: "close", reason, by },
      Effect.succeed,
    );

  /** Why a close is skipped, before the engine is asked. */
  const closeSkip = (task: BoardAgentTaskSummary, force: boolean | undefined) =>
    ENDED.includes(task.state)
      ? `#${task.number} is ${task.state} already.`
      : task.state === "draft"
        ? `#${task.number} is a draft. Discard it instead.`
        : guardOf(task, force);

  const selection = Effect.fn("BoardAgentTools.selection")(function* (input: {
    readonly tasks?: ReadonlyArray<string> | undefined;
    readonly filter?: BoardAgentTaskFilter | undefined;
  }) {
    if ((input.tasks === undefined) === (input.filter === undefined))
      return yield* invalid("Give either `tasks` or `filter`.");
    if (input.tasks !== undefined) {
      const ids = [...new Set(input.tasks)];
      const found = yield* Effect.forEach(
        ids,
        (id) => taskOf(id).pipe(Effect.map((t) => t.summary)),
        {
          concurrency: 4,
        },
      );
      return { tasks: found, more: false };
    }
    return yield* search(input.filter ?? {}, BOARD_AGENT_BULK_MAX);
  });

  /** Binds the token to the action and to each task as it stands now. */
  const tokenOf = (action: unknown, tasks: ReadonlyArray<BoardAgentTaskSummary>) =>
    sha256(
      `${secret}\n${JSON.stringify(action)}\n${JSON.stringify(
        tasks.map((task) => [task.id, task.state, task.lane, task.board, task.updated]).sort(),
      )}`,
    ).pipe(Effect.map((digest) => `bulk-${digest.slice(0, 48)}`));

  const bulk = Effect.fn("BoardAgentTools.bulk")(function* (
    input: {
      readonly tasks?: ReadonlyArray<string> | undefined;
      readonly filter?: BoardAgentTaskFilter | undefined;
      readonly confirm?: boolean | undefined;
      readonly dryRunToken?: string | undefined;
    },
    action: unknown,
    skip: (task: BoardAgentTaskSummary) => string | null,
    act: (task: BoardAgentTaskSummary) => Effect.Effect<unknown, OrchestratorMcpFailure>,
  ) {
    const { tasks, more } = yield* selection(input);
    const token = yield* tokenOf(action, tasks);
    const skipped = new Map(tasks.map((task) => [task.id, skip(task)]));
    const item = (
      task: BoardAgentTaskSummary,
      outcome: "would-act" | "done" | "skipped" | "failed",
      message: string | null,
    ) => ({
      id: task.id,
      number: task.number,
      title: task.title,
      outcome,
      message,
    });
    if (input.confirm !== true)
      return {
        dryRun: true,
        dryRunToken: token,
        more,
        items: tasks.map((task) => {
          const why = skipped.get(task.id) ?? null;
          return item(task, why === null ? "would-act" : "skipped", why);
        }),
      };
    if (input.dryRunToken !== token)
      return yield* invalid(
        "The tasks changed since the dry run, or no dry run was given. Run it again without `confirm` and check the list.",
      );
    const items = yield* Effect.forEach(tasks, (task) => {
      const why = skipped.get(task.id) ?? null;
      if (why !== null) return Effect.succeed(item(task, "skipped", why));
      return act(task).pipe(
        Effect.as(item(task, "done", null)),
        Effect.catch((failure) => Effect.succeed(item(task, "failed", failure.message))),
      );
    });
    return { dryRun: false, dryRunToken: null, more, items };
  });

  const actions: Actions = {
    engineLifecycle: Effect.fn("BoardAgentTools.engineLifecycle")(function* ({ action }) {
      const key = yield* delivery.boardApprovalKey;
      if (!key)
        return yield* new DeliveryError({
          reason: "refused",
          detail: Delivery.NO_BOARD_APPROVAL_KEY,
        });
      const response = yield* delivery.act({
        path: "/api/engine/lifecycle",
        body: { key, action },
      });
      return yield* decodeLifecycle(response.body).pipe(
        Effect.mapError(
          () =>
            new DeliveryError({
              reason: "invalid",
              detail: "The engine did not return a lifecycle receipt. Check its health.",
            }),
        ),
      );
    }),

    listBoards: Effect.gen(function* () {
      const all = yield* boards;
      const repositories = yield* get("/api/repositories", decodeRepositories);
      return {
        boards: all,
        repositories: repositories
          .filter((repository) => repository.kind !== "qualification")
          .map((repository) => ({ id: repository.id, title: repository.title ?? null })),
      };
    }).pipe(Effect.withSpan("BoardAgentTools.listBoards")),

    createBoard: Effect.fn("BoardAgentTools.createBoard")(function* (scope, input) {
      const created = yield* post(
        "/api/boards",
        { ...input, base: input.base ?? null, by: actorOf(scope) },
        Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String })),
      );
      return yield* boardNamed(created.id);
    }),

    editBoard: Effect.fn("BoardAgentTools.editBoard")(function* (scope, { board, ...fields }) {
      yield* boardNamed(board);
      yield* post(`/api/boards/${board}/edit`, { ...fields, by: actorOf(scope) }, Effect.succeed);
      return yield* boardNamed(board);
    }),

    removeBoard: Effect.fn("BoardAgentTools.removeBoard")(function* (scope, { board, force }) {
      const found = yield* boardNamed(board);
      if (found.deploymentLinked && force !== true)
        return yield* invalid(
          `Board ${board} is linked to a deployment project. Pass force only when the person asked.`,
        );
      const { tasks } = yield* search({ board }, SEARCH_MAX);
      const removed = yield* post(
        `/api/boards/${board}/remove`,
        { by: actorOf(scope) },
        decodeRemoved,
      );
      return { removed: removed.removed, tasks: tasks.map((task) => task.id), board: found };
    }),

    listTasks,

    getTask: Effect.fn("BoardAgentTools.getTask")(function* ({ task }) {
      return yield* reread(task);
    }),

    editTask: Effect.fn("BoardAgentTools.editTask")(function* (scope, { task, ...fields }) {
      if (Object.values(fields).every((value) => value === undefined))
        return yield* invalid("Name at least one field to change.");
      yield* post(
        `/api/tasks/${encodeURIComponent(task)}/edit`,
        { ...fields, by: actorOf(scope) },
        Effect.succeed,
      );
      return yield* reread(task);
    }),

    moveTask: Effect.fn("BoardAgentTools.moveTask")(function* (scope, input) {
      if (input.lane === undefined && input.board === undefined)
        return yield* invalid("Give a `lane`, a `board`, or both.");
      const task = yield* taskOf(input.task);
      if (input.board !== undefined) {
        const why = guardOf(task.summary, input.force);
        if (why !== null) return yield* invalid(why);
      }
      yield* move(actorOf(scope), task, input);
      return yield* reread(input.task);
    }),

    submitTask: Effect.fn("BoardAgentTools.submitTask")(function* (scope, { task }) {
      yield* post(
        `/api/tasks/${encodeURIComponent(task)}/submit`,
        { by: actorOf(scope) },
        Effect.succeed,
      );
      return yield* reread(task);
    }),

    closeTask: Effect.fn("BoardAgentTools.closeTask")(function* (scope, { task, reason, force }) {
      const found = yield* taskOf(task);
      const why = closeSkip(found.summary, force);
      if (why !== null) return yield* invalid(why);
      yield* closeOne(actorOf(scope), found.card.id, reason);
      return yield* reread(task);
    }),

    discardTask: Effect.fn("BoardAgentTools.discardTask")(function* (scope, { task, force }) {
      const found = yield* taskOf(task);
      if (found.summary.state !== "draft")
        return yield* invalid(
          `#${found.summary.number} was submitted. Only a draft is discarded; close it instead.`,
        );
      const why = guardOf(found.summary, force);
      if (why !== null) return yield* invalid(why);
      return yield* post(
        `/api/tasks/${encodeURIComponent(found.card.id)}/discard`,
        { by: actorOf(scope) },
        decodeDiscarded,
      );
    }),

    closeTasks: Effect.fn("BoardAgentTools.closeTasks")(function* (scope, input) {
      const by = actorOf(scope);
      return yield* bulk(
        input,
        { action: "close", reason: input.reason, force: input.force === true },
        (task) => closeSkip(task, input.force),
        (task) => closeOne(by, task.id, input.reason),
      );
    }),

    moveTasks: Effect.fn("BoardAgentTools.moveTasks")(function* (scope, input) {
      if (input.lane === undefined && input.board === undefined)
        return yield* invalid("Give a `lane`, a `board`, or both.");
      const by = actorOf(scope);
      return yield* bulk(
        input,
        {
          action: "move",
          lane: input.lane ?? null,
          board: input.board,
          force: input.force === true,
        },
        (task) => (input.board === undefined ? null : guardOf(task, input.force)),
        (task) => taskOf(task.id).pipe(Effect.flatMap((current) => move(by, current, input))),
      );
    }),
  };
  return BoardAgentTools.of({ ...actions, ...folded(actions) });
});

export const layer = Layer.effect(BoardAgentTools, make);

const turnedOff = () =>
  Effect.fail(
    new OrchestratorMcpFailure({ code: "unsupported", message: "Delivery is turned off." }),
  );

const engineOff = () =>
  Effect.fail(new DeliveryError({ reason: "disabled", detail: "Delivery is turned off." }));

/** Inert service, for suites that only need the tool surface to resolve. */
export const layerTest = Layer.succeed(
  BoardAgentTools,
  BoardAgentTools.of({
    listBoards: turnedOff(),
    createBoard: turnedOff,
    editBoard: turnedOff,
    removeBoard: turnedOff,
    listTasks: turnedOff,
    getTask: turnedOff,
    editTask: turnedOff,
    moveTask: turnedOff,
    submitTask: turnedOff,
    closeTask: turnedOff,
    discardTask: turnedOff,
    closeTasks: turnedOff,
    moveTasks: turnedOff,
    engineLifecycle: engineOff,
    board: turnedOff,
    task: turnedOff,
    tasks: turnedOff,
  }),
);
