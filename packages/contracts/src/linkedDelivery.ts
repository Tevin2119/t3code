import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { PeerLink } from "./peerLink.ts";

const Id = Schema.String.check(Schema.isPattern(/^[\w-]{1,256}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NullableString = Schema.NullOr(Schema.String);
const By = Schema.optional(Schema.String.check(Schema.isMaxLength(60)));

const Board = Schema.Struct({
  id: Id,
  title: Schema.String,
  icon: NullableString,
  description: Schema.String,
});
const Counts = Schema.Struct({ tasks: Count, waitingOnYou: Count, questions: Count });
const TaskRef = Schema.Struct({
  id: Id,
  number: Count,
  title: Schema.String,
  state: NullableString,
});
const ThreadRef = Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId });
const TaskThread = Schema.Struct({
  ...ThreadRef.fields,
  kind: Schema.Literals(["board-thread", "source"]),
});

const Card = Schema.Struct({
  ...TaskRef.fields,
  state: Schema.String,
  team: NullableString,
  flow: NullableString,
  lane: NullableString,
  inWorkStage: Schema.NullOr(
    Schema.Literals(["triage", "plan", "build", "checks", "review", "qa"]),
  ),
  revision: Count,
  priority: Schema.Union([NullableString, Schema.Number]),
  owner: NullableString,
  deadline: NullableString,
  created: Schema.String,
  updated: Schema.String,
  submitted: NullableString,
  held: Schema.Boolean,
  first: Schema.Boolean,
  tags: Schema.Array(Schema.String),
  board: Board,
  questions: Count,
  findings: Schema.Struct({ open: Count, all: Count }),
  unread: Count,
  unanswered: Count,
  files: Count,
  blocker: NullableString,
  waitingOn: NullableString,
  waitKind: NullableString,
  stage: NullableString,
  run: Schema.NullOr(Schema.Struct({ id: Id, state: Schema.String, stage: NullableString })),
  paused: Schema.NullOr(
    Schema.Struct({
      kind: Schema.String,
      why: NullableString,
      needsPerson: Schema.Boolean,
      nextTry: NullableString,
      stage: NullableString,
    }),
  ),
  partOf: Schema.NullOr(TaskRef),
  parts: Schema.Array(TaskRef),
  followUps: Schema.Array(TaskRef),
  waitsFor: Schema.Array(Schema.Struct({ ...TaskRef.fields, needsPerson: Schema.Boolean })),
  boardThread: Schema.NullOr(ThreadRef),
  actions: Schema.Array(Schema.Literals(["pause", "resume"])),
});

const Message = Schema.Struct({
  seq: Count,
  at: Schema.String,
  from: Schema.String,
  by: Schema.String,
  kind: Schema.String,
  text: Schema.String,
  state: Schema.String,
  replyTo: Schema.NullOr(Count),
});
const TimelineStep = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    at: Schema.String,
    kind: Schema.String,
    source: Schema.Literals(["message", "event"]),
    order: Count,
    by: NullableString,
    text: Schema.String,
    icon: Schema.String,
    detail: Schema.Boolean,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
const Event = Schema.Struct({
  seq: Count,
  at: Schema.String,
  kind: Schema.String,
  run: NullableString,
  data: Schema.Json,
});
const File = Schema.Struct({
  id: Id,
  name: Schema.String,
  type: Schema.String,
  size: Count,
  sha256: Schema.String,
  by: NullableString,
  at: Schema.String,
  message: Schema.NullOr(Count),
});
const Task = Schema.Struct({
  ...TaskRef.fields,
  state: Schema.String,
  body: Schema.String,
  requirements: Schema.Array(Schema.String),
  acceptance: Schema.Array(Schema.String),
  revision: Count,
  workflow: NullableString,
  team: NullableString,
  origin: Schema.Literals(["thread", "person", "engine"]),
  card: Card,
  parent: Schema.NullOr(TaskRef),
  parts: Schema.Array(TaskRef),
  followUps: Schema.Array(TaskRef),
  links: Schema.Array(
    Schema.Struct({ ...TaskRef.fields, kind: Schema.String, direction: Schema.String }),
  ),
  questions: Schema.Array(
    Schema.Struct({
      seq: Count,
      at: Schema.String,
      by: Schema.String,
      text: Schema.String,
      options: Schema.Array(
        Schema.Struct({ label: Schema.String, meaning: Schema.optional(Schema.String) }),
      ),
    }),
  ),
  files: Schema.Array(File),
  runs: Schema.Array(
    Schema.Struct({
      id: Id,
      team: Schema.String,
      state: Schema.String,
      stage: NullableString,
      created: Schema.String,
    }),
  ),
  revisions: Schema.Array(
    Schema.Struct({
      revision: Count,
      created: Schema.String,
      notes: NullableString,
      body: Schema.String,
      acceptance: Schema.Array(Schema.String),
    }),
  ),
  threads: Schema.Array(TaskThread),
});

const TaskResult = Schema.Struct({ task: Task });
const Messages = Schema.Struct({ messages: Schema.Array(Message) });
const Timeline = Schema.Struct({ timeline: Schema.Array(TimelineStep) });
const FilePiece = Schema.Struct({
  ...File.fields,
  task: Id,
  from: Count,
  length: Count,
  more: Schema.Boolean,
  data: Schema.String,
});
const Attached = Schema.Struct({
  attached: Schema.Array(
    Schema.Struct({
      seat: Schema.String,
      name: Schema.String,
      size: Count,
      kind: Schema.String,
      note: NullableString,
    }),
  ),
});
const Lease = Schema.Struct({
  take: Schema.Struct({
    task: Id,
    holder: NullableString,
    origin: NullableString,
    at: NullableString,
    leaseMs: Schema.NullOr(Count),
    done: Schema.Boolean,
  }),
  ...TaskResult.fields,
});

export const LinkedDeliveryReads = {
  boards: Schema.Struct({ operation: Schema.Literal("boards") }),
  board: Schema.Struct({ operation: Schema.Literal("board"), boardId: Id }),
  search: Schema.Struct({
    operation: Schema.Literal("search"),
    boardId: Schema.optional(Id),
    q: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
    limit: Schema.optional(Count.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  }),
  task: Schema.Struct({ operation: Schema.Literal("task"), taskId: Id }),
  messages: Schema.Struct({ operation: Schema.Literal("messages"), taskId: Id }),
  timeline: Schema.Struct({ operation: Schema.Literal("timeline"), taskId: Id }),
  events: Schema.Struct({
    operation: Schema.Literal("events"),
    taskId: Id,
    after: Schema.optional(Count),
  }),
  file: Schema.Struct({
    operation: Schema.Literal("file"),
    taskId: Id,
    fileId: Id,
    from: Schema.optional(Count),
    length: Schema.optional(Count.check(Schema.isBetween({ minimum: 1, maximum: 262_144 }))),
  }),
  attached: Schema.Struct({ operation: Schema.Literal("attached"), taskId: Id, runId: Id }),
  attachedFile: Schema.Struct({
    operation: Schema.Literal("attachedFile"),
    taskId: Id,
    runId: Id,
    seat: Schema.String.check(Schema.isMaxLength(256)),
    name: Schema.String.check(Schema.isMaxLength(1024)),
  }),
} as const;
export const LinkedDeliveryRead = Schema.Union(Object.values(LinkedDeliveryReads));
export type LinkedDeliveryRead = typeof LinkedDeliveryRead.Type;

const ActionTask = { taskId: Id };
const Answer = Schema.Union([Schema.Struct({ text: Text }), Schema.Struct({ option: Text })]);
export const LinkedDeliveryActions = {
  comment: Schema.Struct({
    operation: Schema.Literal("comment"),
    ...ActionTask,
    text: Text,
    kind: Schema.optional(Schema.Literals(["message", "note"])),
  }),
  answer: Schema.Struct({
    operation: Schema.Literal("answer"),
    ...ActionTask,
    replyTo: Count,
    answer: Answer,
  }),
  control: Schema.Struct({
    operation: Schema.Literal("control"),
    ...ActionTask,
    action: Schema.Literals(["pause", "resume"]),
  }),
  steer: Schema.Struct({
    operation: Schema.Literal("steer"),
    ...ActionTask,
    text: Text,
    seat: Schema.optional(Id),
  }),
  take: Schema.Struct({ operation: Schema.Literal("take"), ...ActionTask, origin: Text }),
  renew: Schema.Struct({ operation: Schema.Literal("renew"), ...ActionTask, holder: Text }),
  release: Schema.Struct({ operation: Schema.Literal("release"), ...ActionTask, holder: Text }),
} as const;
export const LinkedDeliveryAction = Schema.Union(Object.values(LinkedDeliveryActions));
export type LinkedDeliveryAction = typeof LinkedDeliveryAction.Type;

export const LinkedDeliveryResults = {
  boards: Schema.Struct({
    boards: Schema.Array(Schema.Struct({ ...Board.fields, counts: Counts })),
  }),
  board: Schema.Struct({
    board: Board,
    counts: Counts,
    lanes: Schema.Array(
      Schema.Struct({ lane: Schema.String, title: Schema.String, cards: Schema.Array(Card) }),
    ),
  }),
  search: Schema.Struct({ tasks: Schema.Array(Card) }),
  task: Schema.Struct({ ...TaskResult.fields, ...Messages.fields, ...Timeline.fields }),
  messages: Messages,
  timeline: Timeline,
  events: Schema.Struct({ events: Schema.Array(Event) }),
  file: FilePiece,
  attached: Attached,
  attachedFile: Schema.Struct({ mediaType: Schema.String, data: Schema.String }),
  comment: TaskResult,
  answer: TaskResult,
  control: TaskResult,
  steer: TaskResult,
  take: Lease,
  renew: Lease,
  release: Lease,
} as const;

export const LinkedDeliveryDiagnostic = Schema.Literals([
  "offline",
  "unauthorized",
  "read-only",
  "not-linked",
  "environment-mismatch",
  "unsupported",
  "not-found",
  "refused",
  "response-too-large",
]);
export type LinkedDeliveryDiagnostic = typeof LinkedDeliveryDiagnostic.Type;

export const linkedDeliveryResult = <S extends Schema.Top>(schema: S) =>
  Schema.Struct({
    environmentId: EnvironmentId,
    data: Schema.NullOr(schema),
    diagnostic: Schema.NullOr(LinkedDeliveryDiagnostic),
  });

export const LinkedDeliveryReadResult = linkedDeliveryResult(
  Schema.Union([
    LinkedDeliveryResults.boards,
    LinkedDeliveryResults.board,
    LinkedDeliveryResults.search,
    LinkedDeliveryResults.task,
    Messages,
    Timeline,
    LinkedDeliveryResults.events,
    FilePiece,
    Attached,
    LinkedDeliveryResults.attachedFile,
  ]),
);
export const LinkedDeliveryActionResult = linkedDeliveryResult(Schema.Union([Lease, TaskResult]));
export const LinkedDeliveryFresh = Schema.Struct({ fresh: Schema.optional(Schema.Boolean) });
export const LinkedDeliveryPeerTarget = { peerEnvironmentId: EnvironmentId };
export const LinkedDeliveryReadTarget = {
  ...LinkedDeliveryPeerTarget,
  ...LinkedDeliveryFresh.fields,
};
export const LinkedDeliveryLocalRead = Schema.Struct({
  ...LinkedDeliveryReadTarget,
  request: LinkedDeliveryRead,
});
export const LinkedDeliveryBoardsResult = Schema.Struct({
  links: Schema.Array(
    Schema.Struct({
      ...linkedDeliveryResult(LinkedDeliveryResults.boards).fields,
      label: Schema.String,
      access: PeerLink.fields.access,
    }),
  ),
  diagnostic: Schema.NullOr(LinkedDeliveryDiagnostic),
});

const Visibility = Schema.Literals(["shared", "private"]);
export const DeliveryLinkedDestinationBoards = Schema.Array(
  Schema.Struct({
    id: Id,
    title: Schema.String,
    description: Schema.String,
    linkedVisibility: Schema.optional(Visibility),
  }),
);
export const DeliverySetBoardLinkedVisibility = Schema.Struct({
  boardId: Id,
  visibility: Visibility,
  by: By,
});
export const DeliveryBoardLinkedVisibility = Schema.Struct({
  id: Id,
  linkedVisibility: Visibility,
});
export const DeliverySetTaskLinkedHidden = Schema.Struct({
  taskId: Id,
  hidden: Schema.Boolean,
  by: By,
});
export const DeliveryTaskLinkedHidden = Schema.Struct({ task: Id, linkedHidden: Schema.Boolean });

export const LinkedDeliveryThread = Schema.Struct({
  ...ThreadRef.fields,
  tasks: Schema.NonEmptyArray(
    Schema.Struct({
      id: Id,
      number: Count,
      kind: TaskThread.fields.kind,
    }),
  ),
});
export const LinkedDeliveryThreads = Schema.Struct({ threads: Schema.Array(LinkedDeliveryThread) });

export const LinkedDeliveryId = Id;
export const LINKED_HANDOFF_BUNDLE_MAX_BYTES = 16 * 1024 * 1024;
// Prepare returns structured content plus a JSON string whose escaping can double its size.
export const LINKED_HANDOFF_MCP_MAX_BYTES = 52 * 1024 * 1024;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const HandoffState = Schema.Literals(["moving", "done", "restored"]);
const Transfer = {
  root: Id,
  tasks: Schema.Array(Id).check(Schema.isMinLength(1)),
  digest: Digest,
};
const HandoffId = { handoff: Id };
export const LinkedHandoffReceipt = Schema.Struct({
  ...HandoffId,
  digest: Digest,
  outcome: Schema.Literals(["accepted", "cancelled", "occupied"]),
  result: Schema.optional(Schema.Json),
});
const BundleShape = Schema.StructWithRest(
  Schema.Struct({
    ...HandoffId,
    root: Id,
    tasks: Schema.Array(
      Schema.StructWithRest(Schema.Struct({ id: Id }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    ).check(Schema.isMinLength(1)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
// The engine hashes JSON.stringify(bundle), so decoding must keep the original key order.
export const LinkedHandoffBundle = Schema.Unknown.pipe(Schema.refine(Schema.is(BundleShape)));
const Destination = Schema.Struct({ peer: Id, board: Id });
export const LinkedHandoffPrepared = Schema.Struct({
  ...HandoffId,
  state: Schema.Literal("moving"),
  digest: Digest,
  bytes: Count,
  to: Destination,
  tasks: Count,
  bundle: LinkedHandoffBundle,
});
export const LinkedHandoffSummary = Schema.Struct({
  id: Id,
  ...Transfer,
  state: HandoffState,
  to: Destination,
  started: Schema.String,
  updated: Schema.String,
});
const Completion = Schema.Struct({ ...HandoffId, outcome: Schema.Literals(["done", "restored"]) });
const LinkedHandoffPeerRequests = {
  prepare: Schema.Struct({
    operation: Schema.Literal("prepare"),
    ...HandoffId,
    taskId: Id,
    boardId: Id,
  }),
  import: Schema.Struct({
    operation: Schema.Literal("import"),
    boardId: Id,
    bundle: LinkedHandoffBundle,
  }),
  settle: Schema.Struct({ operation: Schema.Literal("settle"), ...HandoffId, ...Transfer }),
  commit: Schema.Struct({
    operation: Schema.Literal("commit"),
    ...HandoffId,
    receipt: LinkedHandoffReceipt,
  }),
  cancel: Schema.Struct({
    operation: Schema.Literal("cancel"),
    ...HandoffId,
    answer: LinkedHandoffReceipt,
  }),
  list: Schema.Struct({ operation: Schema.Literal("list") }),
  get: Schema.Struct({ operation: Schema.Literal("get"), ...HandoffId }),
} as const;
export const LinkedHandoffPeerRead = Schema.Union([
  LinkedHandoffPeerRequests.list,
  LinkedHandoffPeerRequests.get,
]);
export const LinkedHandoffPeerAct = Schema.Union([
  LinkedHandoffPeerRequests.prepare,
  LinkedHandoffPeerRequests.import,
  LinkedHandoffPeerRequests.settle,
  LinkedHandoffPeerRequests.commit,
  LinkedHandoffPeerRequests.cancel,
]);
export const LinkedHandoffPeerRequest = Schema.Union(Object.values(LinkedHandoffPeerRequests));
export type LinkedHandoffPeerRequest = typeof LinkedHandoffPeerRequest.Type;
export const LinkedHandoffPeerResponses = {
  prepare: LinkedHandoffPrepared,
  import: LinkedHandoffReceipt,
  settle: LinkedHandoffReceipt,
  commit: Completion,
  cancel: Completion,
  list: Schema.Struct({ handoffs: Schema.Array(LinkedHandoffSummary) }),
  get: LinkedHandoffSummary,
} as const;
export const linkedHandoffPeerResult = <S extends Schema.Top>(data: S) =>
  Schema.Union([
    Schema.Struct({ environmentId: EnvironmentId, data, error: Schema.Null }),
    Schema.Struct({
      environmentId: EnvironmentId,
      data: Schema.Null,
      error: Schema.Struct({
        message: Schema.String,
        refused: Schema.Boolean,
        status: Schema.optional(Schema.Number),
      }),
    }),
  ]);
export const LinkedHandoffPeerResult = linkedHandoffPeerResult(
  Schema.Union(Object.values(LinkedHandoffPeerResponses)),
);

const Approver = {
  key: Schema.RedactedFromValue(Schema.String),
  by: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)),
};
export const LinkedBringInput = Schema.Struct({
  ...LinkedDeliveryPeerTarget,
  ...Approver,
  taskId: Id,
  boardId: Id,
  handoff: Schema.optional(Id),
});
export const LinkedSendInput = Schema.Struct({
  ...Approver,
  taskId: Id,
  destination: Schema.optional(Schema.Struct({ ...LinkedDeliveryPeerTarget, boardId: Id })),
  handoff: Schema.optional(Id),
});
export const LinkedHandoffRetryInput = Schema.Struct({
  ...Approver,
  ...HandoffId,
  direction: Schema.Literals(["bring", "send"]),
  mode: Schema.optional(Schema.Literals(["retry", "settle"])),
  ...LinkedDeliveryPeerTarget,
});
export const LinkedHandoffsInput = Schema.Struct({
  peerEnvironmentId: Schema.optional(EnvironmentId),
});
export const LinkedHandoffsResult = Schema.Struct({
  handoffs: Schema.Array(
    Schema.Struct({
      ...LinkedHandoffSummary.fields,
      ...LinkedDeliveryPeerTarget,
      direction: Schema.Literals(["bring", "send"]),
    }),
  ),
  unavailablePeers: Schema.Array(EnvironmentId),
});
export const LinkedHandoffOutcome = Schema.Union([
  Schema.Struct({ ...Completion.fields, message: Schema.optional(Schema.String) }),
  Schema.Struct({
    ...HandoffId,
    outcome: Schema.Literal("needs-person"),
    phase: Schema.Literals(["prepare", "settle", "commit", "cancel"]),
    source: Schema.Literals(["local", "linked"]),
    sourceState: Schema.Literals(["frozen", "unknown"]),
    destination: Schema.Literals(["unknown", "accepted", "cancelled", "occupied"]),
    message: Schema.String,
  }),
  Schema.Struct({ ...HandoffId, outcome: Schema.Literal("refused"), message: Schema.String }),
]);
export type LinkedHandoffOutcome = typeof LinkedHandoffOutcome.Type;

export const LinkedArrival = Schema.Struct({
  ...HandoffId,
  peer: Id,
  via: Schema.Literals(["owner", "linked"]),
  fromBoard: Schema.NullOr(Id),
  fromTask: Id,
  fromNumber: Schema.NullOr(Count),
  board: Id,
  at: Schema.String,
});
export const LinkedSendDestinationInput = Schema.Struct({ taskId: Id });
export const LinkedSendDestinationResult = Schema.Struct({
  arrival: Schema.NullOr(LinkedArrival),
  destination: Schema.NullOr(Schema.Struct({ ...LinkedDeliveryPeerTarget, boardId: Id })),
});

export const LinkedArrivalProofInput = Schema.Struct({
  environmentId: EnvironmentId,
  challenge: Id,
  claim: Digest,
});
export const LinkedArrivalProofResult = Schema.Struct({
  environmentId: EnvironmentId,
  proof: Schema.NullOr(Digest),
});
