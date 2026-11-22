import type { TaskView } from "../../lib/delivery";
import { Button } from "../ui/button";
import { actionHelp, actionLabel } from "./taskActions";
import { MobileHelp } from "./taskParts";

/**
 * The decisions a person makes on the task: approve what was tested, send it back with a
 * reason, start or submit it. Kept apart from the composer, and below every tab, so that
 * what is written is never taken for a decision and the buttons are in reach on a phone.
 */
export function DecisionBar(props: {
  readonly task: TaskView;
  readonly actions: ReadonlyArray<string>;
  readonly busy: boolean;
  readonly onAction: (action: string) => void;
}) {
  if (props.actions.length === 0) return null;
  const deciding = props.actions.some((action) => action === "approve" || action === "reject");
  return (
    <section
      className="flex shrink-0 flex-col border-t border-border bg-muted/30 pb-safe"
      aria-label="Your decision"
      data-task-decisions
    >
      <div className="flex flex-col gap-1 px-3 py-1 [@media(min-width:640px)_and_(min-height:600px)]:gap-2 [@media(min-width:640px)_and_(min-height:600px)]:py-2">
        <p className="hidden text-xs font-medium [@media(min-width:640px)_and_(min-height:600px)]:block">
          {deciding ? "Your decision" : "What you can do next"}
          {deciding ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              Messages never count as a decision.
            </span>
          ) : null}
        </p>
        <div className="flex items-center gap-2 [@media(min-width:640px)_and_(min-height:600px)]:flex-wrap">
          {props.actions.map((action) => (
            <div
              key={action}
              className="flex min-w-0 flex-1 flex-col gap-0.5 [@media(min-width:640px)_and_(min-height:600px)]:max-w-80 [@media(min-width:640px)_and_(min-height:600px)]:flex-none"
            >
              <Button
                size="sm"
                variant={action === "reject" ? "outline" : "default"}
                className="w-full justify-center"
                disabled={props.busy}
                onClick={() => props.onAction(action)}
                data-task-action={action}
              >
                <span className="truncate">{actionLabel(action, props.task.card)}</span>
              </Button>
              <span className="hidden text-3xs text-muted-foreground [@media(min-width:640px)_and_(min-height:600px)]:block">
                {actionHelp(action, props.task.card)}
              </span>
            </div>
          ))}
          <MobileHelp label="About your decision">
            {deciding ? <p>Messages never count as a decision.</p> : null}
            {props.actions.map((item) => (
              <p key={item} className="mt-2">
                <strong>{actionLabel(item, props.task.card)}: </strong>
                {actionHelp(item, props.task.card)}
              </p>
            ))}
          </MobileHelp>
        </div>
      </div>
    </section>
  );
}
