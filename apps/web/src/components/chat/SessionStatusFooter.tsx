import type {
  DeliveryThreadBinding,
  DeliveryThreadPending,
  EnvironmentId,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { formatContextWindowTokens, type ContextWindowSnapshot } from "../../lib/contextWindow";
import { SessionDetails } from "../delivery/SessionDetails";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function StatusField(props: { detail: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="max-w-64 truncate" tabIndex={0} />}>
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.detail}</TooltipPopup>
    </Tooltip>
  );
}

export function SessionStatusFooter(props: {
  project: string;
  cwd: string | null;
  branch: string | null;
  dirty: boolean;
  model: string | null;
  phase: string;
  context: ContextWindowSnapshot | null;
  limits: ServerProviderUsageLimits | undefined;
  /** Present when this environment has a delivery engine turned on. */
  delivery?:
    | {
        readonly environmentId: EnvironmentId | null;
        /** Null for a thread that was never bound to a team. */
        readonly binding: DeliveryThreadBinding | null;
        /** A team choice whose setup did not complete. The thread cannot start until it does. */
        readonly held: DeliveryThreadPending | null;
        /** Set when the server could not say whether this thread belongs to a team. */
        readonly unreadable: string | null;
        /** For a draft: the team it will be bound to when sent. */
        readonly pending: string | null;
        readonly onRelease: (() => void) | undefined;
        readonly harness: string | null;
      }
    | undefined;
}) {
  const context = props.context;
  const percentage = context?.usedPercentage;
  const segments = percentage == null ? null : Math.round(percentage / 10);
  return (
    <div
      aria-label="Session status"
      className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-1 font-mono text-[10px] text-muted-foreground sm:px-4"
    >
      {props.delivery?.unreadable ? (
        <StatusField detail={props.delivery.unreadable}>
          <span className="text-warning">team: could not be read, thread held</span>
        </StatusField>
      ) : props.delivery?.held && !props.delivery.binding ? (
        <>
          <StatusField
            detail={`Team ${props.delivery.held.team} was chosen and its setup did not complete${props.delivery.held.why ? `: ${props.delivery.held.why}` : "."} Send again to retry.`}
          >
            <span className="text-warning">team:{props.delivery.held.team} not set up</span>
          </StatusField>
          {props.delivery.onRelease ? (
            <button
              type="button"
              className="cursor-pointer underline decoration-dotted underline-offset-2"
              onClick={props.delivery.onRelease}
            >
              start without a team
            </button>
          ) : null}
        </>
      ) : props.delivery ? (
        props.delivery.pending !== null && !props.delivery.binding ? (
          <StatusField detail="The team this thread is bound to when it is sent">
            team:{props.delivery.pending}
          </StatusField>
        ) : (
          <SessionDetails
            environmentId={props.delivery.environmentId}
            binding={props.delivery.binding}
            harness={props.delivery.harness}
            model={props.model}
            cwd={props.cwd}
            branch={props.branch}
            dirty={props.dirty}
            phase={props.phase}
          />
        )
      ) : null}
      <StatusField detail={props.cwd ?? "No working directory"}>
        {props.cwd?.split(/[\\/]/).findLast(Boolean) ?? props.project}
      </StatusField>
      <StatusField detail="Current checkout; * means uncommitted changes">
        git:{props.branch ?? "unavailable"}
        {props.dirty ? "*" : ""}
      </StatusField>
      {props.model && <StatusField detail="Session model">{props.model}</StatusField>}
      <StatusField
        detail={context ? `Context reported ${context.updatedAt}` : "Context not reported"}
      >
        ctx{" "}
        {segments !== null && (
          <span aria-hidden>
            [{"█".repeat(segments)}
            {"░".repeat(10 - segments)}]{" "}
          </span>
        )}
        {percentage == null ? "unavailable" : `${Math.round(percentage)}% used`}
        {context?.maxTokens != null && ` / ${formatContextWindowTokens(context.maxTokens)}`}
      </StatusField>
      {props.limits?.windows.map((window) => (
        <StatusField
          key={window.id}
          detail={`Allowance used; checked ${props.limits?.checkedAt}${window.resetsAt ? `; resets ${window.resetsAt}` : ""}`}
        >
          {window.label} {Math.round(window.usedPercent)}% used
        </StatusField>
      ))}
      <span>{props.phase}</span>
    </div>
  );
}
