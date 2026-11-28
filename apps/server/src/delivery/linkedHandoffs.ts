import {
  DeliveryError,
  EnvironmentId,
  LINKED_HANDOFF_BUNDLE_MAX_BYTES,
  LinkedArrival,
  LinkedDeliveryId,
  LinkedHandoffPrepared,
  LinkedHandoffPeerId,
  LinkedHandoffReceipt,
  LinkedHandoffSummary,
  type LinkedBringInput,
  type LinkedHandoffOutcome,
  type LinkedHandoffPeerRequest,
  type LinkedHandoffPeerResponses,
  type LinkedHandoffRetryInput,
  type LinkedHandoffsInput,
  type LinkedSendInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DeliveryService from "./DeliveryService.ts";
import { linkedReturnPeer } from "./linkedReturn.ts";

type Direction = "send" | "bring";
type Credentials = Pick<typeof LinkedBringInput.Type, "by" | "key">;
type Destination = NonNullable<typeof LinkedSendInput.Type.destination>;
type Transfer = Pick<typeof LinkedHandoffSummary.Type, "root" | "tasks" | "digest">;
type PeerPhase = <Request extends LinkedHandoffPeerRequest>(
  peer: EnvironmentId,
  request: Request,
) => Effect.Effect<
  (typeof LinkedHandoffPeerResponses)[Request["operation"]]["Type"],
  DeliveryError
>;

const taskView = Schema.Struct({ linkedArrival: Schema.optional(Schema.NullOr(LinkedArrival)) });
const ownerList = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    via: Schema.optional(Schema.NullOr(Schema.String)),
    peer: Schema.optional(Schema.NullOr(Schema.String)),
    to_board: Schema.optional(Schema.NullOr(Schema.String)),
    root: Schema.String,
    tasks: Schema.Array(Schema.String),
    digest: Schema.optional(Schema.NullOr(Schema.String)),
    state: Schema.String,
    started: Schema.String,
    updated: Schema.String,
  }),
);
const completion = Schema.Struct({
  handoff: LinkedDeliveryId,
  outcome: Schema.Literals(["done", "restored"]),
});
const encodeBundle = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isId = Schema.is(LinkedDeliveryId);
const isPeerId = Schema.is(LinkedHandoffPeerId);
const isPullHandoff = (id: string) => /^lk-[a-f0-9]{40}$/.test(id);
const validKey = (key: Credentials["key"]) => {
  const passphrase = Redacted.value(key);
  return passphrase.length > 0 && Buffer.byteLength(passphrase) <= 1024;
};
const refused = (handoff: string, message: string): LinkedHandoffOutcome => ({
  handoff,
  outcome: "refused",
  message,
});
const invalid = new DeliveryError({
  reason: "invalid",
  detail: "The hand-off response is incompatible.",
});
const decode =
  <A>(schema: Schema.Decoder<A>) =>
  (body: unknown) =>
    Schema.decodeUnknownEffect(schema)(body).pipe(Effect.mapError(() => invalid));
const needsPerson = (
  handoff: string,
  direction: Direction,
  phase: "prepare" | "settle" | "commit" | "cancel",
  destination: "unknown" | "accepted" | "cancelled" | "occupied",
  message: string,
  sourceState: "frozen" | "unknown" = phase === "settle" ? "frozen" : "unknown",
): LinkedHandoffOutcome => ({
  handoff,
  outcome: "needs-person",
  source: direction === "send" ? "local" : "linked",
  sourceState,
  phase,
  destination,
  message,
});
const retryUnanswered = {
  schedule: Schedule.recurs(1),
  while: (error: DeliveryError) => error.reason === "unreachable",
};

export function makeLinkedHandoffs(
  peerPhase: PeerPhase,
  actingPeer: (peer: EnvironmentId) => Effect.Effect<{ readonly label: string }, DeliveryError>,
  peerIds: Effect.Effect<ReadonlyArray<EnvironmentId>, DeliveryError>,
  newId: Effect.Effect<string>,
  returnId: (handoff: string) => Effect.Effect<string, never, ServerEnvironment.ServerEnvironment>,
  resolveArrivalPeer: (
    peer: string,
    expectedPeer?: EnvironmentId,
  ) => Effect.Effect<EnvironmentId | null, never, ServerEnvironment.ServerEnvironment>,
) {
  const owner = Effect.fn("LinkedHandoffs.owner")(function* <A>(
    schema: Schema.Decoder<A>,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) {
    const delivery = yield* DeliveryService.DeliveryService;
    return yield* delivery
      .ownerHandoffRequest(method, path, body)
      .pipe(Effect.flatMap(decode(schema)));
  });

  const readArrival = Effect.fn("LinkedHandoffs.readArrival")(function* (
    taskId: string,
    expectedPeer?: EnvironmentId,
  ) {
    if (!isId(taskId)) return yield* invalid;
    const view = yield* owner(taskView, "GET", `/api/tasks/${taskId}`);
    const arrival = view.linkedArrival ?? null;
    const boardId = arrival?.fromBoard;
    const peerEnvironmentId = !arrival
      ? null
      : arrival.via === "owner"
        ? EnvironmentId.make(arrival.peer)
        : yield* resolveArrivalPeer(arrival.peer, expectedPeer);
    const destination = peerEnvironmentId && boardId ? { peerEnvironmentId, boardId } : null;
    return { arrival, destination, peerEnvironmentId };
  });

  const sendDestination = Effect.fn("LinkedHandoffs.sendDestination")(function* (taskId: string) {
    const { arrival, destination } = yield* readArrival(taskId);
    return { arrival, destination };
  });

  const ownerHandoffs = Effect.fn("LinkedHandoffs.ownerHandoffs")(function* (open: boolean) {
    const rows = yield* owner(ownerList, "GET", open ? "/api/handoffs?open=1" : "/api/handoffs");
    return yield* Effect.forEach(
      rows.filter((row) => row.via === "owner" && row.peer != null),
      (row) =>
        decode(LinkedHandoffSummary)({ ...row, to: { peer: row.peer, board: row.to_board } }),
    );
  });

  const settle = Effect.fn("LinkedHandoffs.settle")(function* (
    direction: Direction,
    peer: EnvironmentId,
    handoff: string,
    transfer: Transfer,
  ) {
    const { root, tasks, digest } = transfer;
    return yield* (
      direction === "bring"
        ? owner(LinkedHandoffReceipt, "POST", `/api/transfers/${handoff}/settle`, {
            root,
            tasks,
            digest,
          })
        : peerPhase(peer, { operation: "settle", handoff, root, tasks, digest })
    ).pipe(Effect.retry(retryUnanswered));
  });

  const finish = Effect.fn("LinkedHandoffs.finish")(function* (
    direction: Direction,
    peer: EnvironmentId,
    handoff: string,
    transfer: Transfer,
    credentials: Credentials,
    imported?: typeof LinkedHandoffReceipt.Type,
    importRefusal?: string,
  ) {
    const matches = (receipt: typeof LinkedHandoffReceipt.Type) =>
      receipt.handoff === handoff && receipt.digest === transfer.digest;
    const answer =
      imported && matches(imported)
        ? Result.succeed(imported)
        : yield* settle(direction, peer, handoff, transfer).pipe(Effect.result);
    if (Result.isFailure(answer)) {
      return needsPerson(handoff, direction, "settle", "unknown", answer.failure.detail);
    }
    const { handoff: receiptId, digest, outcome: received } = answer.success;
    const receipt = { handoff: receiptId, digest, outcome: received };
    if (!matches(receipt)) {
      return needsPerson(
        handoff,
        direction,
        "settle",
        "unknown",
        "The destination returned a receipt for another bundle.",
      );
    }
    if (receipt.outcome === "occupied") {
      return needsPerson(
        handoff,
        direction,
        "settle",
        "occupied",
        "The destination already holds work with these task IDs.",
      );
    }
    const accepted = receipt.outcome === "accepted";
    const local = { by: credentials.by, key: Redacted.value(credentials.key) };
    const action =
      direction === "send"
        ? accepted
          ? owner(completion, "POST", `/api/handoffs/${handoff}/commit`, { ...local, receipt })
          : owner(completion, "POST", `/api/handoffs/${handoff}/resolve`, {
              ...local,
              outcome: "restore",
              answer: receipt,
            })
        : accepted
          ? peerPhase(peer, { operation: "commit", handoff, receipt })
          : peerPhase(peer, { operation: "cancel", handoff, answer: receipt });
    const result = yield* action.pipe(Effect.retry(retryUnanswered), Effect.result);
    const outcome = accepted ? "done" : "restored";
    if (
      Result.isSuccess(result) &&
      result.success.handoff === handoff &&
      result.success.outcome === outcome
    ) {
      return {
        handoff,
        outcome,
        ...(!accepted && importRefusal ? { message: importRefusal } : {}),
      } satisfies LinkedHandoffOutcome;
    }
    return needsPerson(
      handoff,
      direction,
      accepted ? "commit" : "cancel",
      receipt.outcome,
      Result.isFailure(result)
        ? result.failure.detail
        : "The source returned an unexpected confirmation.",
    );
  });

  const move = Effect.fn("LinkedHandoffs.move")(function* (
    direction: Direction,
    input: Credentials & { taskId: string },
    target: Destination,
    requestedHandoff: string,
  ) {
    if (!validKey(input.key))
      return refused(requestedHandoff, "Enter the approval passphrase for this machine.");
    const { peerEnvironmentId: peer, boardId } = target;
    if (
      ![input.taskId, boardId, requestedHandoff].every(isId) ||
      !isPeerId(peer) ||
      (direction === "send" && isPullHandoff(requestedHandoff))
    )
      return refused(requestedHandoff, "Invalid hand-off identifier.");
    const link = yield* actingPeer(peer).pipe(Effect.result);
    if (Result.isFailure(link)) return refused(requestedHandoff, link.failure.detail);
    const prepare =
      direction === "bring"
        ? peerPhase(peer, {
            operation: "prepare",
            taskId: input.taskId,
            boardId,
            handoff: requestedHandoff,
          })
        : owner(LinkedHandoffPrepared, "POST", "/api/handoffs/prepare", {
            key: Redacted.value(input.key),
            by: input.by,
            task: input.taskId,
            handoff: requestedHandoff,
            to: { peer, board: boardId, name: link.success.label },
            maxBytes: LINKED_HANDOFF_BUNDLE_MAX_BYTES,
          });
    let uncertain = false;
    const prepared = yield* prepare.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          uncertain ||= error.reason !== "refused";
        }),
      ),
      Effect.retry(retryUnanswered),
      Effect.result,
    );
    if (Result.isFailure(prepared)) {
      return uncertain
        ? needsPerson(requestedHandoff, direction, "prepare", "unknown", prepared.failure.detail)
        : refused(
            requestedHandoff,
            prepared.failure.status === 413
              ? `This task is too large to move. ${prepared.failure.detail}`
              : prepared.failure.detail,
          );
    }
    const { handoff, bundle, digest } = prepared.success;
    if (
      bundle.handoff !== handoff ||
      bundle.root !== input.taskId ||
      prepared.success.to.board !== boardId ||
      (direction === "send" &&
        (prepared.success.to.peer !== peer ||
          linkedReturnPeer(handoff) !== linkedReturnPeer(requestedHandoff)))
    ) {
      return needsPerson(handoff, direction, "prepare", "unknown", invalid.detail);
    }
    const transfer = { root: bundle.root, tasks: bundle.tasks.map((task) => task.id), digest };
    const encoded = direction === "bring" ? yield* encodeBundle(bundle).pipe(Effect.option) : null;
    if (
      encoded !== null &&
      (encoded._tag === "None" ||
        Buffer.byteLength(encoded.value) > LINKED_HANDOFF_BUNDLE_MAX_BYTES)
    ) {
      const message = "The received bundle exceeds the linked hand-off size limit.";
      const outcome = yield* finish(direction, peer, handoff, transfer, input, undefined, message);
      return outcome.outcome === "restored" ? refused(handoff, message) : outcome;
    }
    const imported = yield* (
      direction === "bring"
        ? owner(LinkedHandoffReceipt, "POST", "/api/handoffs/import", {
            key: Redacted.value(input.key),
            by: input.by,
            bundle,
            peer,
            board: boardId,
          })
        : peerPhase(peer, { operation: "import", boardId, bundle })
    ).pipe(Effect.result);
    return yield* finish(
      direction,
      peer,
      handoff,
      transfer,
      input,
      Result.isSuccess(imported) ? imported.success : undefined,
      Result.isFailure(imported) && imported.failure.reason === "refused"
        ? imported.failure.detail
        : undefined,
    );
  });

  const bring = Effect.fn("LinkedHandoffs.bring")(function* (input: typeof LinkedBringInput.Type) {
    return yield* move("bring", input, input, input.handoff ?? (yield* newId));
  });

  const send = Effect.fn("LinkedHandoffs.send")(function* (input: typeof LinkedSendInput.Type) {
    const handoff = input.handoff ?? (yield* newId);
    if (linkedReturnPeer(handoff) !== null) return refused(handoff, "Invalid hand-off identifier.");
    if (input.destination) {
      const link = yield* actingPeer(input.destination.peerEnvironmentId).pipe(Effect.result);
      if (Result.isFailure(link)) return refused(handoff, link.failure.detail);
    }
    const found = yield* readArrival(input.taskId, input.destination?.peerEnvironmentId).pipe(
      Effect.result,
    );
    if (Result.isFailure(found)) return refused(handoff, found.failure.detail);
    const destination = input.destination ?? found.success.destination;
    if (destination === null)
      return refused(handoff, "Choose a linked machine and its Shared board.");
    const returning =
      found.success.arrival?.via === "linked" &&
      found.success.peerEnvironmentId === destination.peerEnvironmentId;
    // Keep the return's receipt namespace in the engine's durable hand-off ID.
    const id = returning ? yield* returnId(handoff) : handoff;
    if (returning && linkedReturnPeer(id) === null) return refused(handoff, invalid.detail);
    return yield* move("send", input, destination, id);
  });

  const list = Effect.fn("LinkedHandoffs.list")(function* (input: typeof LinkedHandoffsInput.Type) {
    const pushes = yield* ownerHandoffs(true);
    const targets = input.peerEnvironmentId ? [input.peerEnvironmentId] : yield* peerIds;
    const pulls = yield* Effect.forEach(
      targets,
      (peerEnvironmentId) =>
        peerPhase(peerEnvironmentId, { operation: "list" }).pipe(
          Effect.result,
          Effect.map((result) => ({ peerEnvironmentId, result })),
        ),
      { concurrency: 4 },
    );
    return {
      handoffs: [
        ...pushes
          .filter((row) => !input.peerEnvironmentId || row.to.peer === input.peerEnvironmentId)
          .map((row) => ({
            ...row,
            peerEnvironmentId: EnvironmentId.make(row.to.peer),
            direction: "send" as const,
          })),
        ...pulls.flatMap(({ peerEnvironmentId, result }) =>
          Result.isFailure(result)
            ? []
            : result.success.handoffs
                .filter((row) => row.state === "moving")
                .map((row) => ({ ...row, peerEnvironmentId, direction: "bring" as const })),
        ),
      ],
      unavailablePeers: pulls.flatMap(({ peerEnvironmentId, result }) =>
        Result.isFailure(result) ? [peerEnvironmentId] : [],
      ),
    };
  });

  const retry = Effect.fn("LinkedHandoffs.retry")(function* (
    input: typeof LinkedHandoffRetryInput.Type,
  ) {
    const { direction, handoff, peerEnvironmentId: peer } = input;
    if (!validKey(input.key))
      return refused(handoff, "Enter the approval passphrase for this machine.");
    if (!isId(handoff) || !isPeerId(peer)) return refused(handoff, "Invalid hand-off identifier.");
    if (isPullHandoff(handoff) !== (direction === "bring"))
      return refused(handoff, "The hand-off does not match that direction.");
    const link = yield* actingPeer(peer).pipe(Effect.result);
    if (Result.isFailure(link))
      return needsPerson(handoff, direction, "settle", "unknown", link.failure.detail, "unknown");
    const found = yield* (
      direction === "send"
        ? ownerHandoffs(false).pipe(
            Effect.map((rows) => rows.find((row) => row.id === handoff && row.to.peer === peer)),
          )
        : peerPhase(peer, { operation: "get", handoff })
    ).pipe(Effect.result);
    if (Result.isFailure(found)) {
      return needsPerson(handoff, direction, "settle", "unknown", found.failure.detail, "unknown");
    }
    const row = found.success;
    if (!row || row.id !== handoff)
      return refused(handoff, "The hand-off could not be found for that link.");
    if (row.state !== "moving")
      return { handoff, outcome: row.state } satisfies LinkedHandoffOutcome;
    if (input.mode === "retry" && direction === "send") {
      return yield* move(
        direction,
        { by: input.by, key: input.key, taskId: row.root },
        { peerEnvironmentId: peer, boardId: row.to.board },
        handoff,
      );
    }
    return yield* finish(direction, peer, handoff, row, input);
  });

  return { bring, send, list, retry, sendDestination };
}

export type LinkedHandoffs = ReturnType<typeof makeLinkedHandoffs>;
