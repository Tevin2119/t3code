import { T, Var, useGT } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type LinkedHandoffOutcome,
  type LinkedHandoffsResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import { ArrowRightLeftIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { LINKED_DIAGNOSTIC_TEXT, linkedLinkCanAct } from "../../lib/linkedBoards";
import {
  deliveryEnvironment,
  useDeliveryRead,
  useLinkedBoards,
  usePersonName,
} from "../../state/delivery";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { ApprovalKeyInput } from "./ApprovalKeyInput";
import { BoardPicker } from "./BoardPicker";
import {
  LINKED_MOVE_NAME_LIMIT,
  linkedMoveActor,
  linkedMoveNotice,
  linkedMoveSavedName,
  localMoveBoards,
} from "./LinkedTaskMoves.logic";

type Move = {
  readonly environmentId: EnvironmentId;
  readonly peerEnvironmentId: EnvironmentId;
  readonly taskId: string;
  readonly boardId: string;
  readonly direction: "send" | "bring";
};

function useOpenMovedTask() {
  const navigate = useNavigate();
  return (move: Move) =>
    void navigate({
      to: "/board",
      search: {
        environment: move.environmentId,
        task: move.taskId,
        ...(move.direction === "send"
          ? { linked: move.peerEnvironmentId, linkedBoard: move.boardId }
          : {}),
      },
    });
}

function MoveDialog(props: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly ready: boolean;
  readonly machine: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onOutcome?: () => void;
  readonly onMove: (credentials: {
    by: string;
    key: Redacted.Redacted<string>;
  }) => Promise<LinkedHandoffOutcome>;
}) {
  const gt = useGT();
  const person = usePersonName();
  const [enteredName, setEnteredName] = useState(() => person.trim());
  const by = linkedMoveActor(person, enteredName);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    if (!props.ready || busy || by === null || !key) return;
    const credentials = { by, key: Redacted.make(key) };
    setKey("");
    setProblem(null);
    setBusy(true);
    const result = await props.onMove(credentials).then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );
    setBusy(false);
    props.onOutcome?.();
    if ("error" in result) {
      setProblem(result.error);
      return;
    }
    if (result.outcome.outcome === "done") {
      toastManager.add({ type: "success", title: gt("Task moved") });
      props.onDone();
      return;
    }
    setProblem(linkedMoveNotice(result.outcome, props.machine));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3 text-sm">
            {props.children}
            {props.ready && (
              <>
                <p>
                  <T>Use the approval passphrase or terminal key for this machine.</T>
                </p>
                {linkedMoveSavedName(person) === null && (
                  <Input
                    aria-label={gt("Your name")}
                    placeholder={gt("Your name")}
                    autoComplete="name"
                    value={enteredName}
                    maxLength={LINKED_MOVE_NAME_LIMIT}
                    disabled={busy}
                    onChange={(event) => setEnteredName(event.target.value)}
                  />
                )}
                <ApprovalKeyInput value={key} onChange={setKey} />
              </>
            )}
            {problem && (
              <p role="status" className="text-warning">
                {problem}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            <T>Close</T>
          </Button>
          <Button
            disabled={!props.ready || busy || by === null || !key}
            onClick={() => void submit()}
          >
            {busy ? gt("Working…") : props.title}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function BringLinkedTask(props: {
  readonly environmentId: EnvironmentId;
  readonly peerEnvironmentId: EnvironmentId;
  readonly taskId: string;
  readonly machine: string;
}) {
  const [open, setOpen] = useState(false);
  const allowed = useAtomValue(deliveryEnvironment.linkedBring.permissionAtom(props.environmentId));
  return allowed ? (
    <>
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        <T>Bring to this machine</T>
      </Button>
      {open && <BringDialog {...props} onClose={() => setOpen(false)} />}
    </>
  ) : null;
}

function BringDialog(props: Parameters<typeof BringLinkedTask>[0] & { onClose: () => void }) {
  const gt = useGT();
  const boardsRead = useDeliveryRead(props.environmentId, "/api/boards");
  const boards = localMoveBoards(boardsRead.body);
  const [boardId, setBoardId] = useState("");
  const board = boards?.find((item) => item.id === boardId);
  const openMovedTask = useOpenMovedTask();
  const bring = useAtomCommand(deliveryEnvironment.linkedBring, { reportFailure: false });
  return (
    <MoveDialog
      title={gt("Bring to this machine")}
      machine={props.machine}
      ready={board !== undefined}
      onClose={props.onClose}
      onDone={() => openMovedTask({ ...props, boardId, direction: "bring" })}
      onMove={async (credentials) => {
        const result = await bring({
          environmentId: props.environmentId,
          input: {
            ...credentials,
            peerEnvironmentId: props.peerEnvironmentId,
            taskId: props.taskId,
            boardId,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      }}
    >
      <BoardPicker
        label={gt("Destination board")}
        marker="bring-destination"
        look="field"
        items={boards ?? []}
        placeholder={gt("Choose a board")}
        value={boardId}
        onChoose={setBoardId}
      />
      {board ? (
        <p>
          <T>
            The task will arrive paused on{" "}
            <strong>
              <Var>{board.title}</Var>
            </strong>{" "}
            and take its visibility (
            <Var>
              {board.linkedVisibility === "shared"
                ? gt("Shared with linked machines")
                : gt("Private")}
            </Var>
            ).
          </T>
        </p>
      ) : boardsRead.error ? (
        <p>{boardsRead.error}</p>
      ) : !boardsRead.isPending && !boards ? (
        <p>
          <T>The delivery engine returned an incompatible board list.</T>
        </p>
      ) : boards?.length === 0 ? (
        <p>
          <T>This machine has no destination boards.</T>
        </p>
      ) : null}
    </MoveDialog>
  );
}

type SendProps = {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly hidden: boolean;
  readonly canSendBack: boolean;
};

export function SendLinkedTask(props: SendProps) {
  const [mode, setMode] = useState<"send" | "back" | null>(null);
  const allowed = useAtomValue(deliveryEnvironment.linkedSend.permissionAtom(props.environmentId));
  return allowed ? (
    <div className="flex flex-wrap justify-end gap-1">
      {props.canSendBack && (
        <Button size="xs" variant="outline" onClick={() => setMode("back")}>
          <T>Send back</T>
        </Button>
      )}
      <Button size="xs" variant="outline" onClick={() => setMode("send")}>
        <T>Send to linked machine</T>
      </Button>
      {mode && <SendDialog {...props} mode={mode} onClose={() => setMode(null)} />}
    </div>
  ) : null;
}

function SendDialog(props: SendProps & { mode: "send" | "back"; onClose: () => void }) {
  const gt = useGT();
  const back = props.mode === "back";
  const links = useLinkedBoards(props.environmentId);
  const origin = useEnvironmentQuery(
    back
      ? deliveryEnvironment.linkedSendDestination({
          environmentId: props.environmentId,
          input: { taskId: props.taskId },
        })
      : null,
  );
  const [peerChoice, setPeerChoice] = useState("");
  const [boardChoice, setBoardChoice] = useState("");
  const openMovedTask = useOpenMovedTask();
  const send = useAtomCommand(deliveryEnvironment.linkedSend, { reportFailure: false });
  const peer = back ? origin.data?.destination?.peerEnvironmentId : peerChoice;
  const boardId = back ? origin.data?.destination?.boardId : boardChoice;
  const link = links.links?.find((entry) => entry.environmentId === peer);
  const board = link?.boards.find((entry) => entry.id === boardId);
  const ready = !!(
    link &&
    board &&
    linkedLinkCanAct(link.access) &&
    link.diagnostic === null &&
    !origin.isPending
  );
  const title = back ? "Send back" : "Send to linked machine";
  return (
    <MoveDialog
      title={title}
      machine={link?.label ?? "The linked machine"}
      ready={ready}
      onClose={props.onClose}
      onDone={() => {
        if (peer && boardId)
          openMovedTask({
            ...props,
            peerEnvironmentId: EnvironmentId.make(peer),
            boardId,
            direction: "send",
          });
      }}
      onMove={async (credentials) => {
        if (!peer || !boardId) throw new Error("Choose a shared board.");
        const result = await send({
          environmentId: props.environmentId,
          input: {
            ...credentials,
            taskId: props.taskId,
            ...(back
              ? {}
              : { destination: { peerEnvironmentId: EnvironmentId.make(peer), boardId } }),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      }}
    >
      {!back && links.links && links.links.length > 0 && (
        <Select
          value={peerChoice}
          onValueChange={(value) => {
            setPeerChoice(value ?? "");
            setBoardChoice("");
          }}
        >
          <SelectTrigger aria-label={gt("Destination machine")}>
            <SelectValue placeholder={gt("Choose a machine")} />
          </SelectTrigger>
          <SelectPopup>
            {links.links.map((entry) => (
              <SelectItem key={entry.environmentId} value={entry.environmentId}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      {!back && link && link.boards.length > 0 && linkedLinkCanAct(link.access) && (
        <BoardPicker
          label={gt("Destination board")}
          marker="send-destination"
          look="field"
          items={link.boards.map((entry) => ({ ...entry, kind: "linked" }))}
          placeholder={gt("Choose a shared board")}
          value={boardChoice}
          onChoose={setBoardChoice}
        />
      )}
      {back && origin.isPending && (
        <p role="status">
          <T>Finding the original board…</T>
        </p>
      )}
      {back && !peer && !origin.isPending && (
        <p>
          <T>The original machine or board is unknown or unreachable.</T>
          {origin.error ? ` ${origin.error}` : ""}
        </p>
      )}
      {back && peer && boardId && !ready && (
        <p>
          <T>
            Original board <Var>{board?.title ?? boardId}</Var> on <Var>{link?.label ?? peer}</Var>.
          </T>
        </p>
      )}
      {links.error && <p>{links.error}</p>}
      {peer && !link && !links.isPending && (
        <p>
          <T>The destination machine is unreachable or no longer linked.</T>
        </p>
      )}
      {!back && links.links?.length === 0 && (
        <p>
          <T>No linked machines are available.</T>
        </p>
      )}
      {link &&
        (!linkedLinkCanAct(link.access) ? (
          <p>
            <T>
              The link to <Var>{link.label}</Var> is read-only.
            </T>
          </p>
        ) : link.diagnostic ? (
          <p>
            {link.label}. {LINKED_DIAGNOSTIC_TEXT[link.diagnostic]}
          </p>
        ) : back && !board ? (
          <p>
            <T>The original board is unavailable. It may be private.</T>
          </p>
        ) : link.boards.length === 0 ? (
          <p>
            <T>
              <Var>{link.label}</Var> has no Shared boards.
            </T>
          </p>
        ) : null)}
      {ready && link && board && (
        <p>
          <T>
            The task will arrive paused on{" "}
            <strong>
              <Var>{board.title}</Var>
            </strong>{" "}
            on{" "}
            <strong>
              <Var>{link.label}</Var>
            </strong>
            , Shared with linked machines.
          </T>
        </p>
      )}
      {props.hidden && (
        <p>
          <T>This task is Hidden from linked machines here.</T>
          {ready && link
            ? gt(" It will become visible to machines linked to {machine}.", {
                machine: link.label,
              })
            : ""}
        </p>
      )}
    </MoveDialog>
  );
}

type PendingMove = (typeof LinkedHandoffsResult.Type)["handoffs"][number];

export function LinkedMovesButton({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<{ move: PendingMove; mode: "retry" | "settle" } | null>(
    null,
  );
  const allowed = useAtomValue(
    deliveryEnvironment.linkedHandoffRetry.permissionAtom(environmentId),
  );
  const query = useEnvironmentQuery(
    open ? deliveryEnvironment.linkedHandoffs({ environmentId, input: {} }) : null,
  );
  const links = useLinkedBoards(open ? environmentId : null);
  const openMovedTask = useOpenMovedTask();
  const retry = useAtomCommand(deliveryEnvironment.linkedHandoffRetry, { reportFailure: false });
  const close = () => {
    setSelected(null);
    setOpen(false);
  };
  const peer = (id: EnvironmentId) => links.links?.find((entry) => entry.environmentId === id);

  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={gt("Task moves")}
        title={gt("Task moves")}
        onClick={() => setOpen(true)}
      >
        <ArrowRightLeftIcon />
      </Button>
      {open && !selected && (
        <Dialog open onOpenChange={(next) => !next && close()}>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>
                <T>Task moves</T>
              </DialogTitle>
            </DialogHeader>
            <DialogPanel>
              {query.isPending && (
                <p role="status">
                  <T>Reading task moves…</T>
                </p>
              )}
              {query.error && <p role="status">{query.error}</p>}
              {query.data && query.data.handoffs.length === 0 && (
                <p>
                  <T>There are no interrupted moves on the machines that answered.</T>
                </p>
              )}
              {query.data && query.data.unavailablePeers.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  <T>
                    Could not read moves from{" "}
                    <Var>
                      {query.data.unavailablePeers.map((id) => peer(id)?.label ?? id).join(", ")}
                    </Var>
                    .
                  </T>
                </p>
              )}
              <ul className="divide-y divide-border">
                {query.data?.handoffs.map((move) => {
                  const link = peer(move.peerEnvironmentId);
                  return (
                    <li
                      key={`${move.peerEnvironmentId}:${move.direction}:${move.id}`}
                      className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                    >
                      <span>
                        {move.direction === "bring"
                          ? gt("{task} · from {machine}", {
                              task: move.root,
                              machine: link?.label ?? move.peerEnvironmentId,
                            })
                          : gt("{task} · to {machine}", {
                              task: move.root,
                              machine: link?.label ?? move.peerEnvironmentId,
                            })}
                      </span>
                      {link?.access === "read-only" ? (
                        <span>
                          <T>The link is read-only.</T>
                        </span>
                      ) : allowed && link ? (
                        <div className="flex gap-1">
                          {move.direction === "send" && (
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => setSelected({ move, mode: "retry" })}
                            >
                              <T>Retry</T>
                            </Button>
                          )}
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => setSelected({ move, mode: "settle" })}
                          >
                            <T>Settle</T>
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                <T>Close</T>
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
      {selected && (
        <MoveDialog
          title={selected.mode === "retry" ? gt("Retry move") : gt("Settle move")}
          machine={peer(selected.move.peerEnvironmentId)?.label ?? selected.move.peerEnvironmentId}
          ready={allowed && peer(selected.move.peerEnvironmentId)?.access !== "read-only"}
          onClose={() => setSelected(null)}
          onOutcome={query.refresh}
          onDone={() => {
            close();
            openMovedTask({
              ...selected.move,
              environmentId,
              taskId: selected.move.root,
              boardId: selected.move.to.board,
            });
          }}
          onMove={async (credentials) => {
            const result = await retry({
              environmentId,
              input: {
                ...credentials,
                mode: selected.mode,
                handoff: selected.move.id,
                direction: selected.move.direction,
                peerEnvironmentId: selected.move.peerEnvironmentId,
              },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            return result.value;
          }}
        >
          <p>
            {selected.mode === "retry"
              ? gt("Try sending the task again.")
              : gt(
                  "Check which machine holds the task. If it never arrived, restore it on the source machine.",
                )}
          </p>
        </MoveDialog>
      )}
    </>
  );
}
