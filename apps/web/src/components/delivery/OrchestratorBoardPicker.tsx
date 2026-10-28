import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { parseTask } from "../../lib/delivery";
import { boardPlacementChoices, matchingProjectBoard } from "../../lib/deliveryBoardPlacement";
import {
  useDeliveryAct,
  useDeliveryRead,
  useOrchestratorDraft,
  useOrchestratorDraftStore,
  usePersonName,
} from "../../state/delivery";
import { BoardDialog, BoardPicker, type PickerItem } from "./BoardPicker";

export function OrchestratorBoardPicker(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: string;
  readonly workspace?: string | null;
}) {
  const draft = useOrchestratorDraft(props.threadId);
  const update = useOrchestratorDraftStore((state) => state.update);
  const person = usePersonName();
  const act = useDeliveryAct(props.environmentId, "orchestrator board");
  const boardsRead = useDeliveryRead(props.environmentId, "/api/boards", { pollMs: 10_000 });
  const boards = boardPlacementChoices(boardsRead.body);
  const taskRead = useDeliveryRead(
    props.environmentId,
    draft?.engineThread ? `/api/tasks/${draft.engineThread}` : null,
  );
  const savedTask = parseTask(taskRead.body);
  const board =
    draft?.board !== undefined
      ? draft.board
      : draft?.engineThread
        ? (savedTask?.card.set ?? null)
        : matchingProjectBoard(boardsRead.body, props.workspace);
  const [boardDialog, setBoardDialog] = useState<{ editing: PickerItem | null } | null>(null);
  const [boardBusy, setBoardBusy] = useState(false);
  const [boardProblem, setBoardProblem] = useState<string | null>(null);
  const saveBoard = async (input: {
    title: string;
    description: string;
    repository?: string;
    base?: string;
    workspace?: string;
  }) => {
    setBoardBusy(true);
    setBoardProblem(null);
    await (async () => {
      const result = await act(
        boardDialog?.editing ? `/api/boards/${boardDialog.editing.id}/edit` : "/api/boards",
        { ...input, by: person },
      );
      if (!result.ok) {
        setBoardProblem(result.why);
        return;
      }
      if (
        !boardDialog?.editing &&
        result.body &&
        typeof result.body === "object" &&
        "id" in result.body
      )
        update(props.threadId, { board: String(result.body.id) });
      setBoardDialog(null);
      boardsRead.refresh();
    })().finally(() => setBoardBusy(false));
  };
  return (
    <>
      <BoardPicker
        label="Board"
        marker="composer"
        look="field"
        items={[
          {
            id: "__no_board__",
            title: "Not on a board",
            description: "Keep this work outside boards.",
            kind: "built-in",
          },
          ...boards,
        ]}
        value={board ?? "__no_board__"}
        newLabel="New board…"
        onChoose={(id) => update(props.threadId, { board: id === "__no_board__" ? null : id })}
        onCreate={() => setBoardDialog({ editing: null })}
        onEdit={(editing) => setBoardDialog({ editing })}
        noneYet="Create a board for this project, or keep the chat off boards."
      />
      {boardDialog ? (
        <BoardDialog
          key={boardDialog.editing?.id ?? "new"}
          kind="board"
          environmentId={props.environmentId}
          workspace={props.workspace ?? null}
          by={person}
          editing={boardDialog.editing}
          busy={boardBusy}
          problem={boardProblem}
          onClose={() => setBoardDialog(null)}
          onSave={(input) => void saveBoard(input)}
        />
      ) : null}
    </>
  );
}
