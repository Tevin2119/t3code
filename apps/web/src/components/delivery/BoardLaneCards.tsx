import { useGT, useMessages } from "gt-react";
import {
  CircleHelpIcon,
  FileTextIcon,
  PackageCheckIcon,
  PenLineIcon,
  PlayIcon,
  RotateCcwIcon,
  SendIcon,
  ShieldCheckIcon,
  SignpostIcon,
  UserIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  standingApprovers,
  WORK_STAGE_TITLE,
  waitKindsOf,
  workSections,
  type WaitKind,
} from "../../lib/boardLaneCards";
import type { DeliveryCard } from "../../lib/delivery";
import { useBoardControls, useBoardPreferences } from "../../state/delivery";
import { Badge } from "../ui/badge";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";

const WAIT_ICON: Record<WaitKind, ReactNode> = {
  question: <CircleHelpIcon />,
  proposal: <PenLineIcon />,
  "sign-off": <ShieldCheckIcon />,
  plan: <FileTextIcon />,
  deliverables: <PackageCheckIcon />,
  decision: <SignpostIcon />,
  submit: <SendIcon />,
  resume: <PlayIcon />,
  other: <UserIcon />,
};

/**
 * What a person owes a card, one badge per kind: a question, a plan to read, a sign-off. The
 * kinds and their counts are what the card payload says (`waitsOnPerson`, `questions`,
 * `approvals`, `actions`); a badge offers nothing to press.
 */
export function WaitKinds(props: { readonly card: DeliveryCard }) {
  const gt = useGT();
  const { card } = props;
  const kinds = waitKindsOf(card);
  if (kinds.length === 0) return null;
  const label = (kind: WaitKind): string => {
    switch (kind) {
      case "question":
        return gt("{count, plural, one {A question for you} other {{count} questions for you}}", {
          count: card.questions,
        });
      case "proposal":
        return gt("{count, plural, one {A change to confirm} other {{count} changes to confirm}}", {
          count: card.proposals,
        });
      case "sign-off": {
        const names = standingApprovers(card);
        return names.length > 0
          ? gt("Waiting for your sign-off. {names} approved.", { names: names.join(", ") })
          : gt("Waiting for your sign-off");
      }
      case "plan":
        return gt("A plan to read");
      case "deliverables":
        return gt("Deliverables to accept");
      case "decision":
        return gt("Stopped for your decision");
      case "submit":
        return gt("Waiting for you to submit it");
      case "resume":
        return gt("Paused until you resume it");
      case "other":
        return gt("Needs you");
    }
  };
  return (
    <span className="flex flex-wrap items-center gap-1" data-card-wait-kinds>
      {kinds.map((kind) => (
        <Badge
          key={kind}
          variant="warning"
          size="sm"
          className="h-auto min-h-4 max-w-full shrink whitespace-normal py-0.5 text-left"
          data-wait-kind={kind}
        >
          {WAIT_ICON[kind]}
          <span className="min-w-0">{label(kind)}</span>
        </Badge>
      ))}
    </span>
  );
}

/**
 * A queued card's place and who holds the slots. The place comes from the order of the lane
 * (or the engine's own position); the slots and holders only when the engine sends them. There
 * is no time estimate, because it would go stale and mislead.
 */
export function QueueLine(props: { readonly card: DeliveryCard; readonly place: number | null }) {
  const gt = useGT();
  const { card, place } = props;
  const queue = card.queue;
  if (place === null) {
    return (
      <p className="text-2xs text-muted-foreground" data-card-queue="not-in-line">
        {gt("Not submitted yet, so not in line")}
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-2xs" data-card-queue="in-line">
      <p className="font-medium">
        {gt(
          "{place, selectordinal, one {{place}st in line} two {{place}nd in line} few {{place}rd in line} other {{place}th in line}}",
          { place },
        )}
        {queue ? (
          <span className="font-normal text-muted-foreground">
            <span aria-hidden> · </span>
            {gt("{busy} of {cap} slots busy", { busy: queue.busy, cap: queue.cap })}
          </span>
        ) : null}
      </p>
      {queue && queue.holders.length > 0 ? (
        <div className="text-muted-foreground" data-card-queue-holders>
          <span>{gt("Holding the slots")}</span>
          <ul className="flex flex-col">
            {queue.holders.map((holder) => (
              <li key={holder.id} className="break-words">
                #{holder.number} {holder.title}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** A rework round, as a count on the card. It is not a lane and not a section. */
export function ReworkCount(props: { readonly rounds: number | null }) {
  const gt = useGT();
  return (
    <Badge variant="warning" size="sm" data-card-rework={props.rounds ?? "yes"}>
      <RotateCcwIcon />
      {props.rounds === null
        ? gt("In rework")
        : gt("Rework round {rounds}", { rounds: props.rounds })}
    </Badge>
  );
}

/**
 * The In work lane: one section per stage, each with its count, under the same collapsible
 * header the thread sidebar's shelves use. A section a person folds stays folded, kept with the
 * board's other folds. A stage with no card has no section.
 */
export function InWorkSections(props: {
  readonly environmentId: EnvironmentId | null;
  readonly cards: ReadonlyArray<DeliveryCard>;
  readonly renderCard: (card: DeliveryCard) => ReactNode;
}) {
  const m = useMessages();
  const { laneFolds } = useBoardPreferences(props.environmentId);
  const { foldLane } = useBoardControls(props.environmentId);
  return (
    <>
      {workSections(props.cards).map((section) => {
        const key = `in-work:${section.stage}`;
        const expanded = !(laneFolds[key] ?? false);
        return (
          <section
            key={section.stage}
            data-work-stage={section.stage}
            className="flex flex-col gap-1.5"
          >
            <CollapsibleSectionHeader
              expanded={expanded}
              onClick={() => foldLane(key, expanded)}
              accessory={
                <span className="font-normal tabular-nums" data-work-stage-count>
                  {section.cards.length}
                </span>
              }
            >
              {m(WORK_STAGE_TITLE[section.stage])}
            </CollapsibleSectionHeader>
            {expanded ? section.cards.map((card) => props.renderCard(card)) : null}
          </section>
        );
      })}
    </>
  );
}
