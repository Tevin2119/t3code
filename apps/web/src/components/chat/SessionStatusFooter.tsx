import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { formatContextWindowTokens, type ContextWindowSnapshot } from "../../lib/contextWindow";
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
}) {
  const context = props.context;
  const percentage = context?.usedPercentage;
  const segments = percentage == null ? null : Math.round(percentage / 10);
  return (
    <div
      aria-label="Session status"
      className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-1 font-mono text-[10px] text-muted-foreground sm:px-4"
    >
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
