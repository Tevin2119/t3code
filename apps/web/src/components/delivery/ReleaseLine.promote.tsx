import type {
  DeploymentCompare,
  DeploymentProject,
  DeploymentPromotion,
  DeploymentPromotionAction,
  EnvironmentId,
} from "@t3tools/contracts";
import { ArrowUpIcon } from "lucide-react";
import { useState } from "react";
import { RelativeTime } from "../RelativeTime";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import type { DeploymentRequest } from "./DeploymentInstance";
import { InstanceChip } from "./ReleaseLine.chip";
import { PromotionSync, SurvivalReport, type SyncCheckout } from "./ReleaseLine.sync";
import {
  compareReadingProblem,
  promoteBlocked,
  promotionActionLabel,
  promotionView,
  promotionConfirmation,
  type PendingConfirm,
} from "./ReleaseLine.logic";

const FORBIDDEN = "This connection does not have permission to change deployments.";
const UNAVAILABLE = "This reading is stale or unavailable. Refresh before promoting.";

/** The compare reading behind the strip, so a confirmation can ask for a fresh one. */
export type CompareReading = {
  readAt: string | null;
  error: string | null;
  stale: boolean;
  refresh: () => void;
};

/**
 * Promote, or sync hotfixes first, and the promotion the engine keeps for this pair. Opening a
 * confirmation reads the difference again, and the dialog says what moves from that reading;
 * it is then signed in the deployment approval dialog.
 */
export function PromotionControls({
  environmentId,
  checkout,
  compare,
  reading,
  from,
  to,
  promotion,
  unavailable,
  disabled,
  onRequest,
}: {
  environmentId: EnvironmentId;
  checkout: SyncCheckout | null;
  /** Null until the difference is read: an open promotion still shows, with its actions. */
  compare: DeploymentCompare | null;
  reading: CompareReading;
  from: DeploymentProject;
  to: DeploymentProject;
  promotion: DeploymentPromotion | null;
  unavailable: boolean;
  disabled: boolean;
  onRequest: (request: DeploymentRequest) => void;
}) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const view = promotion ? promotionView(promotion) : null;
  // The parent disables every deployment change without permission or a fresh reading.
  const why = !disabled ? null : unavailable ? UNAVAILABLE : FORBIDDEN;
  const readingProblem = compareReadingProblem({
    error: reading.error,
    stale: reading.stale,
    hasCompare: !!compare,
  });
  const blocked = compare ? promoteBlocked(compare) : null;
  const syncFirst = compare?.promote === "sync-hotfixes-first";
  // An open promotion offers its own actions; a new one is asked only once none is open.
  const actions = view?.open ? view.actions : [];
  const offerPromote = !!compare && !view?.open;
  // Moving a branch rests on the difference; withdrawing or reading again does not.
  const movesBranch = (action: DeploymentPromotionAction) => action === "advance";
  const open = (next: PendingConfirm) => {
    setPending(next);
    reading.refresh();
  };
  const after = () => reading.refresh();
  const status = why ?? (offerPromote ? (readingProblem ?? blocked) : null);

  const shown = pending
    ? promotionConfirmation({
        pending,
        readAt: reading.readAt,
        error: reading.error,
        compare,
        promotion,
        to,
        from,
      })
    : null;
  const confirm = shown?.state === "ready" ? shown.confirm : null;
  const title = !pending
    ? ""
    : pending.kind === "promote"
      ? syncFirst
        ? `Sync hotfixes into ${from.environment} first`
        : `Promote ${from.environment} into ${to.environment}`
      : promotionActionLabel(pending.action);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-release-promotion>
      {promotion && view ? (
        <div className="flex min-w-0 flex-col gap-1" data-promotion-state={promotion.state}>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
            <InstanceChip tone={view.tone} label={view.label} />
            <span className="min-w-0 break-words text-muted-foreground">
              Promotion asked by {promotion.by}
              {promotion.updatedAt ? (
                <>
                  {" "}
                  · <RelativeTime timestamp={promotion.updatedAt} />
                </>
              ) : null}
            </span>
          </div>
          {view.reason ? (
            <p className="break-words text-xs text-foreground" data-promotion-reason>
              {view.reason}
            </p>
          ) : null}
          <PromotionSync
            environmentId={environmentId}
            promotion={promotion}
            checkout={checkout}
            from={from}
            to={to}
          />
        </div>
      ) : null}
      {actions.length || offerPromote ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              size="xs"
              variant={action === "advance" ? "default" : "outline"}
              disabled={disabled || (movesBranch(action) && !!readingProblem)}
              onClick={() =>
                open({
                  kind: "action",
                  action,
                  openedAt: reading.readAt,
                  // Approve is for the head whose survival report the card shows now.
                  ...(action === "approve" ? { head: promotion?.resolution?.head ?? null } : {}),
                })
              }
            >
              {promotionActionLabel(action)}
            </Button>
          ))}
          {offerPromote ? (
            <Button
              size="xs"
              variant={syncFirst ? "outline" : "default"}
              disabled={disabled || !!readingProblem || !!blocked}
              onClick={() => open({ kind: "promote", openedAt: reading.readAt })}
            >
              {syncFirst ? <PullRequestGlyph.merged aria-hidden /> : <ArrowUpIcon aria-hidden />}
              {syncFirst ? "Sync hotfixes first" : `Promote to ${to.environment}`}
            </Button>
          ) : null}
          {status || (actions.includes("advance") && readingProblem) ? (
            <span role="status" className="text-xs text-muted-foreground" data-promotion-status>
              {status ?? readingProblem}
            </span>
          ) : null}
        </div>
      ) : null}
      <AlertDialog open={pending !== null} onOpenChange={(next) => !next && setPending(null)}>
        {pending ? (
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm?.title ?? title}</AlertDialogTitle>
              <AlertDialogDescription data-promotion-moves>
                {confirm?.moves ??
                  (shown?.state === "problem" || shown?.state === "moved"
                    ? shown.why
                    : `Reading ${from.environment} and ${to.environment} again…`)}
              </AlertDialogDescription>
              {/* The card is behind the modal, so an approval shows the report it signs here. */}
              {confirm &&
              pending.kind === "action" &&
              pending.action === "approve" &&
              promotion?.resolution ? (
                <div className="max-h-72 overflow-y-auto text-left" data-promotion-approve-report>
                  <SurvivalReport resolution={promotion.resolution} />
                </div>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>
                {pending.kind === "action" && pending.action === "cancel"
                  ? "Keep promotion"
                  : "Cancel"}
              </AlertDialogClose>
              {shown?.state === "moved" && pending.kind === "action" ? (
                <Button onClick={() => setPending({ ...pending, head: shown.head })}>
                  Review {shown.head.slice(0, 12)}
                </Button>
              ) : (
                <Button
                  disabled={!confirm || disabled}
                  onClick={() => {
                    if (!confirm) return;
                    onRequest({
                      title: confirm.title,
                      path: confirm.path,
                      body: confirm.body,
                      after,
                    });
                    setPending(null);
                  }}
                >
                  {(confirm?.submit ?? title).replace(/…$/, "")}…
                </Button>
              )}
            </AlertDialogFooter>
          </AlertDialogPopup>
        ) : null}
      </AlertDialog>
    </div>
  );
}
