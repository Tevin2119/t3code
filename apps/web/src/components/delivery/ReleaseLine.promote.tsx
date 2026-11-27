import type { DeploymentCompare, DeploymentProject, DeploymentPromotion } from "@t3tools/contracts";
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
import {
  promoteConfirm,
  promotionActionConfirm,
  promotionActionLabel,
  promotionView,
  type PromotionConfirm,
} from "./ReleaseLine.logic";

const FORBIDDEN = "This connection does not have permission to change deployments.";
const UNAVAILABLE = "This reading is stale or unavailable. Refresh before promoting.";

/**
 * Promote, or sync hotfixes first, and the promotion the engine keeps for this pair. Each request
 * is confirmed here with what moves, then signed in the deployment approval dialog.
 */
export function PromotionControls({
  compare,
  from,
  to,
  promotion,
  unavailable,
  disabled,
  onRequest,
}: {
  /** Null until the difference is read: an open promotion still shows, with its actions. */
  compare: DeploymentCompare | null;
  from: DeploymentProject;
  to: DeploymentProject;
  promotion: DeploymentPromotion | null;
  unavailable: boolean;
  disabled: boolean;
  onRequest: (request: DeploymentRequest) => void;
}) {
  const [confirm, setConfirm] = useState<PromotionConfirm | null>(null);
  const view = promotion ? promotionView(promotion) : null;
  // The parent disables every deployment change without permission or a fresh reading.
  const why = !disabled ? null : unavailable ? UNAVAILABLE : FORBIDDEN;
  const nothing =
    compare?.promote === "promote" && compare.ahead.count === 0
      ? `Nothing on ${from.environment} is missing from ${to.environment}.`
      : null;
  const names = { from: from.environment, to: to.environment, toBranch: to.branch };
  const syncFirst = compare?.promote === "sync-hotfixes-first";
  // An open promotion offers its own actions; a new one is asked only once none is open.
  const actions = view?.open ? view.actions : [];
  const promote = compare && !view?.open ? promoteConfirm(compare, to) : null;
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
        </div>
      ) : null}
      {actions.length || promote ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {actions.map((action) => (
            <Button
              key={action}
              size="xs"
              variant={action === "advance" ? "default" : "outline"}
              disabled={disabled}
              onClick={() => setConfirm(promotionActionConfirm(promotion!, action, names))}
            >
              {promotionActionLabel(action)}
            </Button>
          ))}
          {promote ? (
            <Button
              size="xs"
              variant={syncFirst ? "outline" : "default"}
              disabled={disabled || !!nothing}
              onClick={() => setConfirm(promote)}
            >
              {syncFirst ? <PullRequestGlyph.merged aria-hidden /> : <ArrowUpIcon aria-hidden />}
              {syncFirst ? "Sync hotfixes first" : `Promote to ${to.environment}`}
            </Button>
          ) : null}
          {why || (promote && nothing) ? (
            <span role="status" className="text-xs text-muted-foreground">
              {why ?? nothing}
            </span>
          ) : null}
        </div>
      ) : null}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        {confirm ? (
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
              <AlertDialogDescription data-promotion-moves>{confirm.moves}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>
                {confirm.body.action === "cancel" ? "Keep promotion" : "Cancel"}
              </AlertDialogClose>
              <Button
                onClick={() => {
                  onRequest({ title: confirm.title, path: confirm.path, body: confirm.body });
                  setConfirm(null);
                }}
              >
                {confirm.submit}…
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        ) : null}
      </AlertDialog>
    </div>
  );
}
