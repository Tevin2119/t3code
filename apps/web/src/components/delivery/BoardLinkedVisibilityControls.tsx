import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useSetBoardLinkedVisibility } from "../../state/delivery";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** What each visibility choice is called, as the board's setting names it. */
const BOARD_LINKED_VISIBILITY_LABEL: Readonly<Record<"private" | "shared", string>> = {
  private: "Private",
  shared: "Shared with linked machines",
};

/**
 * Whether a board of this environment is shared with the machines linked to it. Only the
 * machine that owns the board changes this; both directions are one choice away.
 */
export function BoardLinkedVisibilityControls(props: {
  readonly environmentId: EnvironmentId | null;
  readonly board: string;
  readonly visibility: "shared" | "private";
  readonly onDone: () => void;
}) {
  const { allowed, set } = useSetBoardLinkedVisibility(props.environmentId);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = (visibility: "shared" | "private") => {
    if (busy || visibility === props.visibility) return;
    setBusy(true);
    setProblem(null);
    void set(props.board, visibility).then((outcome) => {
      setBusy(false);
      if (!outcome.ok) setProblem(outcome.why);
      props.onDone();
    });
  };
  return (
    <section
      className="min-w-0 space-y-2"
      aria-label="Linked machines"
      data-board-linked-visibility
    >
      <h3 className="text-sm font-medium">Linked machines</h3>
      <p className="text-xs text-muted-foreground">
        Shared with linked machines means anyone on a machine linked to this one can see and act on
        this board. Private means no linked machine is shown it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={props.visibility}
          onValueChange={(value) => {
            if (value === "shared" || value === "private") change(value);
          }}
        >
          <SelectTrigger aria-label="Board visibility for linked machines" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="private">{BOARD_LINKED_VISIBILITY_LABEL.private}</SelectItem>
            <SelectItem value="shared">{BOARD_LINKED_VISIBILITY_LABEL.shared}</SelectItem>
          </SelectPopup>
        </Select>
        {!allowed ? (
          <span className="text-xs text-muted-foreground">
            This connection cannot change the board's visibility.
          </span>
        ) : null}
      </div>
      {problem ? <p className="text-xs text-warning">{problem}</p> : null}
    </section>
  );
}
