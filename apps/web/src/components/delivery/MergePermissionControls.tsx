import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MergePermissionView } from "@t3tools/contracts";
import { useState } from "react";
import { parseMergePermission } from "../../lib/boardDelivery";
import { deliveryEnvironment, useDeliveryRead, useStaleReading } from "../../state/delivery";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { BoardDeliveryApproval } from "./BoardDeliveryApproval";

export function MergePermissionSummary({
  policy,
}: {
  policy: MergePermissionView | null | undefined;
}) {
  if (!policy)
    return (
      <p className="text-xs text-muted-foreground">
        Automatic merge permission is unavailable from this engine.
      </p>
    );
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-merge-permission>
      <p>
        Override: {policy.setting} · Effective: {policy.resolved}
      </p>
      <p className="break-words">
        Source: {policy.source}
        {policy.sourceId ? ` ${policy.sourceId}` : ""}
        {policy.by ? ` · ${policy.by}` : ""}
        {policy.since ? ` · ${policy.since}` : ""}
      </p>
      {policy.requestedBy ? (
        <p>
          Override saved by {policy.requestedBy}
          {policy.requestedSince ? ` · ${policy.requestedSince}` : ""}
        </p>
      ) : null}
      <p>
        {policy.eligible
          ? "Policy eligible only, not merge-ready."
          : `Not policy eligible: ${policy.blockingReason ?? "unknown"}.`}{" "}
        Mode: {policy.mode}. Executor: {policy.execution}.
      </p>
      {policy.problem ? <p className="text-warning-foreground">{policy.problem}</p> : null}
    </div>
  );
}

export function MergePermissionControls(props: {
  environmentId: EnvironmentId;
  path: string;
  policy: MergePermissionView | null | undefined;
  onDone: () => void;
  readOnly?: boolean;
  stale?: boolean;
  /** Where the section around the controls already carries their title. */
  untitled?: boolean;
}) {
  const allowed = useAtomValue(deliveryEnvironment.act.permissionAtom(props.environmentId));
  const [setting, setSetting] = useState<"on" | "off" | "inherit" | null>(null);
  const [signing, setSigning] = useState<"on" | "off" | "inherit" | null>(null);
  const selected = setting ?? props.policy?.setting ?? "inherit";
  return (
    <section className="min-w-0 space-y-2" aria-label="Automatic merge permission">
      {props.untitled ? null : <h3 className="text-sm font-medium">Automatic merge permission</h3>}
      <MergePermissionSummary policy={props.policy} />
      <p className="text-xs text-muted-foreground">
        Permission alone never merges. Full-auto mode and the engine's independent merge checks
        still apply. It grants no deployment permission.
      </p>
      {props.stale ? (
        <p className="text-xs text-warning-foreground">
          Snapshot is stale. Refresh before changing permission.
        </p>
      ) : null}
      {!props.readOnly && props.policy ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={selected}
            onValueChange={(value) => {
              if (value === "on" || value === "off" || value === "inherit") setSetting(value);
            }}
          >
            <SelectTrigger aria-label="Merge permission override" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="inherit">Inherit</SelectItem>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="on">On</SelectItem>
            </SelectPopup>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={
              !allowed ||
              props.stale ||
              !!props.policy.problem ||
              ["qualification", "task-unavailable"].includes(props.policy.blockingReason ?? "")
            }
            onClick={() => setSigning(selected)}
          >
            Save permission…
          </Button>
        </div>
      ) : null}
      {signing ? (
        <BoardDeliveryApproval
          environmentId={props.environmentId}
          title="Save merge permission"
          unavailable={
            !!props.stale ||
            !!props.readOnly ||
            !props.policy ||
            !!props.policy.problem ||
            ["qualification", "task-unavailable"].includes(props.policy?.blockingReason ?? "")
          }
          path={props.path}
          body={{ mergePermission: signing }}
          description={
            signing === "inherit"
              ? "Remove only this override. This can reveal inherited On permission from a task ancestor, board or global setting."
              : `Set automatic merge permission ${signing} at this scope. Other layers and execution checks remain unchanged.`
          }
          {...(signing === "on"
            ? {
                confirmation:
                  "I authorize guarded automatic merges when full-auto mode and the engine's checks allow them. Eligibility is not merge readiness or an atomic veto on concurrent host metadata changes.",
              }
            : {})}
          onClose={() => setSigning(null)}
          onDone={() => {
            setSigning(null);
            setSetting(null);
            props.onDone();
          }}
        />
      ) : null}
    </section>
  );
}

export function GlobalMergePermission({ environmentId }: { environmentId: EnvironmentId }) {
  const read = useDeliveryRead(environmentId, "/api/engine/merge-permission");
  const stale = useStaleReading(read.readAt);
  return (
    <div className="space-y-2">
      {read.error ? <p className="text-xs text-warning-foreground">{read.error}</p> : null}
      <MergePermissionControls
        environmentId={environmentId}
        path="/api/engine/merge-permission"
        policy={read.error ? null : parseMergePermission(read.body)}
        stale={stale || !!read.error}
        onDone={read.refresh}
      />
      <Button variant="ghost" size="sm" onClick={read.refresh}>
        Refresh permission
      </Button>
    </div>
  );
}
