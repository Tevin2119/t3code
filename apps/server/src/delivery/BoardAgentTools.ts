import {
  BOARD_AGENT_BULK_MAX,
  type DeliveryEngineLifecycleReceipt,
  DeliveryError,
  OrchestratorMcpFailure,
  isReservedBoardTaskBoard,
  type BoardAgentBoard,
  type BoardAgentBoardToolInput,
  type BoardAgentBoardToolResult,
  type BoardAgentTask,
  type BoardAgentTaskFilter,
  type BoardAgentTaskSummary,
  type BoardAgentTaskToolInput,
  type BoardAgentTaskToolResult,
  type BoardAgentTasksToolInput,
  type BoardAgentTasksToolResult,
  type DeliveryEngineControlInput,
  type DeliveryEngineControlResult,
  type DeliveryEngineLifecycleInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
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
const decodeCreated = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;
const CHANNELS = ["dev", "qa", "main"] as const;
const field = (body: unknown, name: string) =>
  typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
const shaped = (value: unknown, pattern: RegExp) =>
  typeof value === "string" && pattern.test(value) ? value : null;

/**
 * An engine control's answer, reduced to what it may say: accepted or done, and the receipt's
 * id, commit and channel only in their fixed formats. The rest is dropped unread.
 */
function engineControlSummary(
  action: DeliveryEngineControlInput["action"],
  body: unknown,
): DeliveryEngineControlResult {
  const channel = field(body, "channel");
  return {
    ok: true,
    action,
    state: field(body, "accepted") === true ? "accepted" : "done",
    id: shaped(field(body, "id"), UUID),
    commit: shaped(field(body, "commit"), COMMIT),
    channel: CHANNELS.find((known) => known === channel) ?? null,
  };
}

/** The engine's own cap on one task search. It has no cursor. */
const SEARCH_MAX = 500;
/** States in which a close has nothing left to end. */
const ENDED = ["closed", "rejected", "merged", "moved", "moving"];
const LIVE_RUN = ["admitted", "running"];
/** Repositories whose boards and tasks need `force`, deployment project or not (illusivetrading). */
const PROTECTED_REPOSITORY = /illusivetrading/i;
/** How long a dry run's token stands, and how many stand at once. */
const PREVIEW_MS = 15 * 60 * 1_000;
const PREVIEWS_MAX = 100;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const incompatible = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The delivery engine answered in a shape this T3 does not read. Update the engine.",
  });
const notFound = (error: DeliveryError) => error.reason === "refused" && error.status === 404;

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

const protectedRepository = (repository: string | null | undefined) =>
  repository != null && PROTECTED_REPOSITORY.test(repository);

const summaryOf = (card: Card, protectedBoards: ReadonlySet<string>): BoardAgentTaskSummary => ({
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
  protected:
    (card.deployment !== undefined && card.deployment !== null) ||
    (card.set != null && protectedBoards.has(card.set)) ||
    protectedRepository(card.target?.repository),
});

const queryMatches = (query: string, task: BoardAgentTaskSummary) => {
  const number = /^#?(\d+)$/.exec(query.trim())?.[1];
  if (number !== undefined) return String(task.number).includes(number);
  const hay = `${task.number} ${task.id} ${task.title} ${task.team ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word.replace(/^#/, "")));
};

/** Every predicate, checked here: the engine's search answers `origin` alone, ignoring the rest. */
const matches = (filter: BoardAgentTaskFilter) => (task: BoardAgentTaskSummary) =>
  (filter.board === undefined || task.board === filter.board) &&
  (filter.lane === undefined || task.lane === filter.lane) &&
  (filter.state === undefined || task.state === filter.state) &&
  (filter.origin === undefined || task.origin === filter.origin) &&
  (filter.query === undefined || queryMatches(filter.query, task)) &&
  (filter.updatedBefore === undefined ||
    (task.updated !== null && task.updated < filter.updatedBefore));

/** A filter as one key: fields sorted, blanks dropped, so two spellings of it bind the same. */
const normalFilter = (filter: BoardAgentTaskFilter | undefined) =>
  filter === undefined
    ? null
    : Object.fromEntries(
        Object.entries(filter)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([key, value]) => [key, value.trim()] as const)
          .filter(([, value]) => value !== "")
          .sort(([a], [b]) => a.localeCompare(b)),
      );

/** One key for a list of plain values: what a dry run's token binds. */
const keyOf = (parts: ReadonlyArray<unknown>) => JSON.stringify(parts);

/** What decides whether an action may run on a task: it is bound by a dry run's token. */
const eligibilityOf = (task: BoardAgentTaskSummary) =>
  keyOf([task.state, task.lane, task.board, task.live, task.protected]);

/** Why a guarded change is refused without `force`, or null. */
const guardOf = (task: BoardAgentTaskSummary, force: boolean | undefined) =>
  force === true
    ? null
    : task.live
      ? `#${task.number} has a live run. Pass force only when the person asked to stop it.`
      : task.protected
        ? `#${task.number} is on a protected board or repository. Pass force only when the person asked.`
        : null;

const closeSkip = (task: BoardAgentTaskSummary, force: boolean | undefined) =>
  ENDED.includes(task.state)
    ? `#${task.number} is ${task.state} already.`
    : task.state === "draft"
      ? `#${task.number} is a draft. Discard it instead.`
      : guardOf(task, force);

const discardSkip = (task: BoardAgentTaskSummary, force: boolean | undefined) =>
  task.state !== "draft"
    ? `#${task.number} was submitted. Only a draft is discarded; close it instead.`
    : guardOf(task, force);

/** What a dry run's answer tells the agent to do next: no undo follows the confirm. */
const NEXT =
  "Nothing was changed. Show this to the person; only if they agree, call again with the same fields, `confirm: true` and this `dryRunToken`. It cannot be undone.";

const needs = <A>(value: A | undefined, what: string) =>
  value === undefined
    ? Effect.fail(invalid(`This action needs \`${what}\`.`))
    : Effect.succeed(value);

export class BoardAgentTools extends Context.Service<
  BoardAgentTools,
  {
    /** `delivery_board`: list, create, edit, or remove after a dry run. */
    readonly board: (
      scope: McpInvocationScope,
      input: BoardAgentBoardToolInput,
    ) => Effect.Effect<BoardAgentBoardToolResult, OrchestratorMcpFailure>;
    /** `delivery_task`: one action on one task; close and discard after a dry run. */
    readonly task: (
      scope: McpInvocationScope,
      input: BoardAgentTaskToolInput,
    ) => Effect.Effect<BoardAgentTaskToolResult, OrchestratorMcpFailure>;
    /** `delivery_tasks`: list, or close or move many after a dry run of the same call. */
    readonly tasks: (
      scope: McpInvocationScope,
      input: BoardAgentTasksToolInput,
    ) => Effect.Effect<BoardAgentTasksToolResult, OrchestratorMcpFailure>;
    /**
     * A keyed engine control with the approval key saved on this server. The key goes only to
     * the engine; with none saved, nothing is sent. Refusals are fixed text.
     */
    readonly engineControl: (
      input: DeliveryEngineControlInput,
    ) => Effect.Effect<DeliveryEngineControlResult, DeliveryError>;
    readonly engineLifecycle: (
      input: DeliveryEngineLifecycleInput,
    ) => Effect.Effect<typeof DeliveryEngineLifecycleReceipt.Type, DeliveryError>;
  }
>()("t3/delivery/BoardAgentTools") {}

interface Preview {
  /** The call it previewed, so a confirm of another call is refused. */
  readonly binding: string;
  /** Each task or board as it stood, in the order the dry run listed them. */
  readonly snapshots: ReadonlyArray<readonly [string, string]>;
  readonly expires: number;
}

const make = Effect.gen(function* () {
  const delivery = yield* Delivery.DeliveryService;
  const random = yield* SecureRandom.SecureRandom;
  // A dry run's token stands for what it showed, held here: a restart asks for a new dry run.
  const previews = new Map<string, Preview>();

  const preview = Effect.fn("BoardAgentTools.preview")(function* (
    binding: string,
    snapshots: ReadonlyArray<readonly [string, string]>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    for (const [token, held] of previews) if (held.expires <= now) previews.delete(token);
    while (previews.size >= PREVIEWS_MAX) previews.delete(previews.keys().next().value!);
    const token = `dry-${yield* random.uuidV4().pipe(Effect.orDie)}`;
    previews.set(token, { binding, snapshots, expires: now + PREVIEW_MS });
    return token;
  });
  /** The dry run a confirm names, used once. Refused for any other call. */
  const confirmed = Effect.fn("BoardAgentTools.confirmed")(function* (
    token: string | undefined,
    binding: string,
  ) {
    if (token === undefined)
      return yield* invalid("`confirm` needs the `dryRunToken` of a dry run of this same call.");
    const held = previews.get(token);
    previews.delete(token);
    if (held === undefined || held.expires <= (yield* Clock.currentTimeMillis))
      return yield* invalid("This dry run is unknown or expired. Run it again without `confirm`.");
    if (held.binding !== binding)
      return yield* invalid(
        "This confirm differs from its dry run. Run the dry run again with the same fields.",
      );
    return held.snapshots;
  });

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

  const boards = get("/api/boards", decodeBoards).pipe(
    Effect.map((all) =>
      all.map((board): BoardAgentBoard => ({
        id: board.id,
        title: board.title,
        description: board.description ?? "",
        icon: board.icon ?? null,
        repository: board.target?.repository ?? null,
        base: board.target?.base ?? null,
        protected:
          board.deploymentProjectId != null || protectedRepository(board.target?.repository),
      })),
    ),
  );
  const protectedBoards = boards.pipe(
    Effect.map((all) => new Set(all.filter((board) => board.protected).map((board) => board.id))),
  );
  const boardNamed = Effect.fn("BoardAgentTools.boardNamed")(function* (id: string) {
    const found = (yield* boards).find((board) => board.id === id);
    if (found === undefined)
      return yield* invalid(`No board ${id}. List them with the delivery_board list action.`);
    return found;
  });

  /** One task as it stands, or null when the engine has none by that id. */
  const lookup = Effect.fn("BoardAgentTools.lookup")(function* (id: string) {
    const read = yield* delivery
      .read({ path: `/api/tasks/${encodeURIComponent(id)}` })
      .pipe(Effect.result);
    if (read._tag === "Failure") {
      if (notFound(read.failure)) return null;
      return yield* engineFailure(read.failure);
    }
    const card = yield* decodeCard(read.success.body).pipe(Effect.mapError(incompatible));
    return { card, summary: summaryOf(card, yield* protectedBoards) };
  });
  const taskOf = Effect.fn("BoardAgentTools.taskOf")(function* (id: string) {
    const found = yield* lookup(id);
    if (found === null) return yield* invalid(`No task ${id}.`);
    return found;
  });
  const detail = (id: string) =>
    taskOf(id).pipe(
      Effect.map(({ card, summary }): BoardAgentTask => ({ ...summary, body: card.body ?? null })),
    );

  const search = Effect.fn("BoardAgentTools.search")(function* (
    filter: BoardAgentTaskFilter,
    limit: number,
  ) {
    // The engine is asked for its newest tasks only to narrow the read; every predicate is
    // checked again below.
    const params = new URLSearchParams({ set: filter.board ?? "all", limit: String(SEARCH_MAX) });
    if (filter.lane !== undefined) params.set("lane", filter.lane);
    const cards = yield* get(`/api/tasks?${params.toString()}`, decodeCards);
    const shown = yield* protectedBoards;
    const found = cards.map((card) => summaryOf(card, shown)).filter(matches(filter));
    return {
      tasks: found.slice(0, limit),
      more: found.length > limit,
      truncated: cards.length >= SEARCH_MAX,
    };
  });

  const placeOnBoard = Effect.fn("BoardAgentTools.placeOnBoard")(function* (
    by: string,
    task: { card: Card },
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

  /** `seen` makes the engine refuse a lane move of a card that moved since it was read. */
  const move = Effect.fn("BoardAgentTools.move")(function* (
    by: string,
    task: { card: Card; summary: BoardAgentTaskSummary },
    input: { lane?: string | undefined; board?: string | null | undefined; base?: string },
  ) {
    if (input.board !== undefined) yield* placeOnBoard(by, task, input.board, input.base);
    if (input.lane !== undefined)
      yield* post(
        `/api/tasks/${encodeURIComponent(task.card.id)}/move`,
        {
          lane: input.lane,
          by,
          ...(task.summary.lane === null ? {} : { seen: task.summary.lane }),
        },
        Effect.succeed,
      );
  });
  // The engine's close takes no expected state, so the re-read just before it is the check.
  const closeOne = (by: string, id: string, reason: string) =>
    post(
      `/api/tasks/${encodeURIComponent(id)}/control`,
      { action: "close", reason, by },
      Effect.succeed,
    );
  const discardOne = (by: string, id: string) =>
    post(`/api/tasks/${encodeURIComponent(id)}/discard`, { by }, Effect.succeed);

  /**
   * One task's irreversible action: a dry run returns its token; a confirm re-reads the task and
   * acts only if what decides the action is as the dry run saw it.
   */
  const oneAfterDryRun = Effect.fn("BoardAgentTools.oneAfterDryRun")(function* (
    input: BoardAgentTaskToolInput,
    binding: string,
    skip: (task: BoardAgentTaskSummary) => string | null,
    act: (task: {
      card: Card;
      summary: BoardAgentTaskSummary;
    }) => Effect.Effect<unknown, OrchestratorMcpFailure>,
  ) {
    const found = yield* taskOf(input.task);
    if (input.confirm !== true) {
      const why = skip(found.summary);
      if (why !== null) return yield* invalid(why);
      const token = yield* preview(binding, [[found.card.id, eligibilityOf(found.summary)]]);
      return { ...found.summary, body: found.card.body ?? null, dryRunToken: token, next: NEXT };
    }
    const [[, before] = ["", ""]] = yield* confirmed(input.dryRunToken, binding);
    if (eligibilityOf(found.summary) !== before)
      return yield* invalid(
        `#${found.summary.number} changed since the dry run. Run it again and check it.`,
      );
    yield* act(found);
    return found;
  });

  const board: BoardAgentTools["Service"]["board"] = Effect.fn("BoardAgentTools.board")(
    function* (scope, input) {
      const by = actorOf(scope);
      switch (input.action) {
        case "list": {
          const repositories = yield* get("/api/repositories", decodeRepositories);
          return {
            boards: yield* boards,
            repositories: repositories
              .filter((repository) => repository.kind !== "qualification")
              .map((repository) => ({ id: repository.id, title: repository.title ?? null })),
          };
        }
        case "create": {
          const created = yield* post(
            "/api/boards",
            {
              title: yield* needs(input.title, "title"),
              repository: yield* needs(input.repository, "repository"),
              base: input.base ?? null,
              description: input.description,
              icon: input.icon,
              by,
            },
            decodeCreated,
          );
          return { boards: [yield* boardNamed(created.id)] };
        }
        case "edit": {
          const id = yield* needs(input.board, "board");
          const found = yield* boardNamed(id);
          if (found.protected && input.force !== true)
            return yield* invalid(
              `Board ${id} is protected. Pass force only when the person asked.`,
            );
          const { title, description, repository, base, icon } = input;
          yield* post(
            `/api/boards/${id}/edit`,
            { title, description, repository, base, icon, by },
            Effect.succeed,
          );
          return { boards: [yield* boardNamed(id)] };
        }
        case "remove": {
          const id = yield* needs(input.board, "board");
          const found = yield* boardNamed(id);
          if (found.protected && input.force !== true)
            return yield* invalid(
              `Board ${id} is protected. Pass force only when the person asked.`,
            );
          const { tasks, truncated } = yield* search({ board: id }, SEARCH_MAX);
          if (truncated)
            return yield* invalid(
              `Board ${id} has more tasks than one read shows (${SEARCH_MAX}), so a dry run could not list them all. Close or move some of its tasks first, then remove it.`,
            );
          const kept = tasks.map((task) => task.id);
          const standing = keyOf([found.protected, [...kept].sort()]);
          const binding = keyOf(["board-remove", id, input.force === true]);
          if (input.confirm !== true)
            return {
              boards: [found],
              tasks: kept,
              dryRunToken: yield* preview(binding, [[id, standing]]),
              next: NEXT,
            };
          const [[, before] = ["", ""]] = yield* confirmed(input.dryRunToken, binding);
          if (standing !== before)
            return yield* invalid(
              `Board ${id} or its tasks changed since the dry run. Run it again and check it.`,
            );
          yield* post(`/api/boards/${id}/remove`, { by }, Effect.succeed);
          return { boards: [found], tasks: kept };
        }
      }
    },
  );

  const task: BoardAgentTools["Service"]["task"] = Effect.fn("BoardAgentTools.task")(
    function* (scope, input) {
      const by = actorOf(scope);
      const { task: id, force } = input;
      switch (input.action) {
        case "get":
          return yield* detail(id);
        case "edit": {
          const { title, body, priority, tags } = input;
          if ([title, body, priority, tags].every((value) => value === undefined))
            return yield* invalid("Name at least one field to change.");
          yield* post(
            `/api/tasks/${encodeURIComponent(id)}/edit`,
            { title, body, priority, tags, by },
            Effect.succeed,
          );
          return yield* detail(id);
        }
        case "move": {
          if (input.lane === undefined && input.board === undefined)
            return yield* invalid("Give a `lane`, a `board`, or both.");
          const found = yield* taskOf(id);
          if (input.board !== undefined) {
            const why = guardOf(found.summary, force);
            if (why !== null) return yield* invalid(why);
          }
          yield* move(by, found, {
            lane: input.lane,
            board: input.board,
            ...(input.base === undefined ? {} : { base: input.base }),
          });
          return yield* detail(id);
        }
        case "submit":
          yield* post(`/api/tasks/${encodeURIComponent(id)}/submit`, { by }, Effect.succeed);
          return yield* detail(id);
        case "close": {
          const reason = yield* needs(input.reason, "reason");
          const found = yield* taskOf(id);
          const why = closeSkip(found.summary, force);
          if (why !== null) return yield* invalid(why);
          yield* closeOne(by, found.card.id, reason);
          return yield* detail(id);
        }
        case "discard": {
          const done = yield* oneAfterDryRun(
            input,
            keyOf(["task-discard", id, force === true]),
            (summary) => discardSkip(summary, force),
            (found) => discardOne(by, found.card.id),
          );
          return "dryRunToken" in done
            ? done
            : { ...done.summary, body: done.card.body ?? null, state: "discarded", lane: null };
        }
      }
    },
  );

  const tasks: BoardAgentTools["Service"]["tasks"] = Effect.fn("BoardAgentTools.tasks")(
    function* (scope, input) {
      if (input.action === "list") return yield* search(input.filter ?? {}, input.limit ?? 100);
      const by = actorOf(scope);
      const { force, lane, board } = input;
      if ((input.tasks === undefined) === (input.filter === undefined))
        return yield* invalid("Give either `tasks` or `filter`.");
      const reason = input.action === "close" ? yield* needs(input.reason, "reason") : null;
      if (input.action === "move" && lane === undefined && board === undefined)
        return yield* invalid("Give a `lane`, a `board`, or both.");
      const skip = (summary: BoardAgentTaskSummary) =>
        reason !== null
          ? closeSkip(summary, force)
          : board === undefined
            ? null
            : guardOf(summary, force);
      const act = (found: { card: Card; summary: BoardAgentTaskSummary }) =>
        reason !== null ? closeOne(by, found.card.id, reason) : move(by, found, { lane, board });
      const ids = input.tasks === undefined ? null : [...new Set(input.tasks)];
      // What decides the action: the call itself, its filter or its ids, and each task's state.
      const binding = keyOf([
        input.action,
        reason,
        lane ?? null,
        board === undefined ? null : { board },
        force === true,
        normalFilter(input.filter),
        ids === null ? null : [...ids].sort(),
      ]);
      const item = (
        id: string,
        found: BoardAgentTaskSummary | null,
        outcome: "would-act" | "done" | "skipped" | "failed" | "not-found",
        message: string | null,
      ) => ({
        id,
        number: found?.number ?? null,
        title: found?.title ?? null,
        outcome,
        message,
      });

      // The selection as it stands: by ids, each looked up; or the filter's matches.
      const select = Effect.fn("BoardAgentTools.select")(function* () {
        if (ids === null) {
          const listed = yield* search(input.filter ?? {}, BOARD_AGENT_BULK_MAX);
          return {
            found: listed.tasks.map((summary) => [summary.id, summary] as const),
            more: listed.more,
            truncated: listed.truncated,
          };
        }
        const found = yield* Effect.forEach(
          ids,
          (id) =>
            lookup(id).pipe(Effect.map((hit) => [id, hit === null ? null : hit.summary] as const)),
          { concurrency: 4 },
        );
        return { found, more: false, truncated: false };
      });

      const { found, more, truncated } = yield* select();
      if (input.confirm !== true) {
        const snapshots = found.flatMap(([id, summary]) =>
          summary === null ? [] : [[id, eligibilityOf(summary)] as const],
        );
        return {
          more,
          truncated,
          dryRunToken: yield* preview(binding, snapshots),
          next: NEXT,
          items: found.map(([id, summary]) => {
            if (summary === null) return item(id, null, "not-found", `No task ${id}.`);
            const why = skip(summary);
            return item(id, summary, why === null ? "would-act" : "skipped", why);
          }),
        };
      }
      const snapshots = yield* confirmed(input.dryRunToken, binding);
      if (
        ids === null &&
        keyOf(found.map(([id]) => id).sort()) !== keyOf(snapshots.map(([id]) => id).sort())
      )
        return yield* invalid(
          "The tasks this filter matches changed since the dry run. Run it again and check the list.",
        );
      const seen = new Map(snapshots);
      // Each task is read again just before its write, and acted on only as the dry run saw it.
      const items = yield* Effect.forEach(ids ?? snapshots.map(([id]) => id), (id) =>
        Effect.gen(function* () {
          const before = seen.get(id);
          const current = yield* lookup(id).pipe(Effect.result);
          if (current._tag === "Failure") return item(id, null, "failed", current.failure.message);
          if (current.success === null) return item(id, null, "not-found", `No task ${id}.`);
          const { summary } = current.success;
          if (before === undefined || eligibilityOf(summary) !== before)
            return item(id, summary, "skipped", "changed since the dry run");
          const why = skip(summary);
          if (why !== null) return item(id, summary, "skipped", why);
          return yield* act(current.success).pipe(
            Effect.as(item(id, summary, "done", null)),
            Effect.catch((failure) => Effect.succeed(item(id, summary, "failed", failure.message))),
          );
        }),
      );
      return { more, truncated, items };
    },
  );

  const ENGINE_PATH: Record<DeliveryEngineControlInput["action"], string> = {
    stop: "/api/engine/lifecycle",
    restart: "/api/engine/lifecycle",
    update: "/api/engine/update",
    later: "/api/engine/update/later",
    channel: "/api/engine/channel",
  };
  const engineControl: BoardAgentTools["Service"]["engineControl"] = Effect.fn(
    "BoardAgentTools.engineControl",
  )(function* ({ action, commit, channel }) {
    const key = yield* delivery.boardApprovalKey;
    if (!key)
      return yield* new DeliveryError({
        reason: "refused",
        detail: Delivery.NO_BOARD_APPROVAL_KEY,
      });
    const body =
      action === "stop" || action === "restart" ? { key, action } : { key, commit, channel };
    // The relay gives a keyed refusal in fixed words; an answer is reduced here.
    const response = yield* delivery.act({ path: ENGINE_PATH[action], body });
    return engineControlSummary(action, response.body);
  });

  return BoardAgentTools.of({
    board,
    task,
    tasks,
    engineControl,
    engineLifecycle: Effect.fn("BoardAgentTools.engineLifecycle")(function* ({ action }) {
      const summary = yield* engineControl({ action });
      if (summary.state !== "accepted" || summary.id === null)
        return yield* new DeliveryError({
          reason: "invalid",
          detail: "The engine did not return a lifecycle receipt. Check its health.",
        });
      return { accepted: true as const, id: summary.id, action };
    }),
  });
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
    board: turnedOff,
    task: turnedOff,
    tasks: turnedOff,
    engineControl: engineOff,
    engineLifecycle: engineOff,
  }),
);
