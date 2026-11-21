import { useGT } from "gt-react";
import { ArrowUpRightIcon, RocketIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import {
  cardMergeExecutionFact,
  cardMergePermissionFact,
  cardPublicationFact,
  type CardMergeExecutionFact,
  type CardMergePermissionFact,
  type CardPublicationFact,
} from "../../lib/deliveryStates";
import type { DeliveryCard } from "../../lib/delivery";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { cn } from "../../lib/utils";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { TaskDeploymentBadge } from "./TaskDeploymentStatus";

const LINK_CLASS =
  "inline-flex shrink-0 items-center gap-0.5 text-primary underline-offset-2 hover:underline";

type Card = Pick<DeliveryCard, "publication" | "deployment" | "run" | "mergePermission">;

/**
 * A card's publication, deployment and merge facts, each as the engine reported it. On the
 * board card it is one quiet line per fact and nothing when there is no publication; in the
 * task's deployments panel it also says the merge permission, which applies before any
 * pull request exists. It shows no actions: those come only from the card's `actions` list.
 */
export function CardDeliveryStatus({
  card,
  variant,
}: {
  card: Card & Pick<DeliveryCard, "id">;
  variant: "card" | "panel";
}) {
  const publication = cardPublicationFact(card);
  // Merge permission and the engine's merge matter on a card only while its pull request is open.
  const showMerge = variant === "panel" || publication?.kind === "pull-request";
  const permission = showMerge ? cardMergePermissionFact(card.mergePermission) : null;
  const execution = showMerge ? cardMergeExecutionFact(card) : null;
  const deployment = publication?.kind === "deployed" ? null : card.deployment;
  if (!publication && !permission && !execution && !(variant === "card" && deployment)) return null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        variant === "card" ? "gap-0.5 text-2xs" : "gap-1.5 border-b px-3 py-2 text-xs",
      )}
      data-card-delivery={variant}
    >
      {publication ? <PublicationLine fact={publication} full={variant === "panel"} /> : null}
      {variant === "card" && deployment ? (
        <TaskDeploymentBadge card={card as DeliveryCard} />
      ) : null}
      {permission ? <PermissionLine fact={permission} /> : null}
      {execution ? <ExecutionLine fact={execution} /> : null}
    </div>
  );
}

function Line(props: { kind: string; tone?: "warning"; icon?: ReactNode; children: ReactNode }) {
  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 break-words",
        props.tone === "warning" ? "text-warning-foreground" : "text-muted-foreground",
      )}
      data-card-delivery-fact={props.kind}
    >
      {props.icon}
      {props.children}
    </span>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-3xs [overflow-wrap:anywhere]">{children}</span>
);

function PullRequestLink({ number, url }: { number: number; url: string }) {
  const openPrLink = useOpenPrLink();
  return (
    <a
      href={url}
      className={LINK_CLASS}
      data-card-delivery-pr
      onClick={(event) => {
        // The card itself opens on a click; the link opens the pull request instead.
        event.stopPropagation();
        openPrLink(event, url);
      }}
    >
      PR #{number}
      <ArrowUpRightIcon aria-hidden className="size-3" />
    </a>
  );
}

function PublicationLine({ fact, full }: { fact: CardPublicationFact; full: boolean }) {
  const gt = useGT();
  const openLink = useOpenLink(null);
  const external = (url: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.stopPropagation();
    if (event.button > 1) return;
    event.preventDefault();
    void openLink(url, { event }).catch((error: unknown) => console.error(error));
  };
  const icon = (Icon: typeof RocketIcon | (typeof PullRequestGlyph)["merged"]) => (
    <Icon aria-hidden className="size-3 shrink-0" />
  );
  switch (fact.kind) {
    case "pull-request":
      return (
        <Line kind="pull-request" icon={icon(PullRequestGlyph.pullRequest)}>
          <span>{gt("Pull request open")}</span>
          <PullRequestLink number={fact.number} url={fact.url} />
        </Line>
      );
    case "merged":
      return (
        <Line kind="merged" icon={icon(PullRequestGlyph.merged)}>
          <span className="font-medium text-foreground">{gt("Merged")}</span>
          {fact.mergeCommit ? (
            // The card has room for a short commit; the panel shows it whole.
            <Code>{full ? fact.mergeCommit : fact.mergeCommit.slice(0, 12)}</Code>
          ) : (
            <span>{gt("The host has not reported a merge commit.")}</span>
          )}
          {fact.pullRequest ? <PullRequestLink {...fact.pullRequest} /> : null}
        </Line>
      );
    case "deployed":
      return (
        <Line kind="deployed" icon={icon(RocketIcon)}>
          <span className="font-medium text-foreground">{gt("Deployed")}</span>
          <span className="min-w-0 break-words">
            {fact.environment ? `${fact.project} · ${fact.environment}` : fact.project}
          </span>
          {/* Preview, logs and deployment id come from the deployment; shown only once reported. */}
          {fact.previewUrl ? (
            <a href={fact.previewUrl} onClick={external(fact.previewUrl)} className={LINK_CLASS}>
              {gt("Preview")}
              <ArrowUpRightIcon aria-hidden className="size-3" />
            </a>
          ) : null}
          {fact.logsUrl ? (
            <a href={fact.logsUrl} onClick={external(fact.logsUrl)} className={LINK_CLASS}>
              {gt("Logs")}
              <ArrowUpRightIcon aria-hidden className="size-3" />
            </a>
          ) : null}
          {fact.deploymentId ? <Code>{fact.deploymentId}</Code> : null}
        </Line>
      );
    case "publication":
      return (
        <Line kind="publication" icon={icon(PullRequestGlyph.pullRequest)}>
          <span>{gt("Publication")}</span>
          <Code>{fact.state}</Code>
        </Line>
      );
  }
}

function PermissionLine({ fact }: { fact: CardMergePermissionFact }) {
  const gt = useGT();
  switch (fact.kind) {
    case "off": {
      const layer =
        fact.source === "task"
          ? gt("set on this task")
          : fact.source === "ancestor"
            ? gt("set on parent task {id}", { id: fact.sourceId ?? "" })
            : fact.source === "board"
              ? gt("set on board {id}", { id: fact.sourceId ?? "" })
              : fact.source === "global"
                ? gt("set for the whole engine")
                : gt("nothing set, so off by default");
      return (
        <Line kind="merge-off">
          <span>{gt("Automatic merge off")}</span>
          <span data-merge-source={fact.source}>{layer}</span>
        </Line>
      );
    }
    case "not-eligible":
      return (
        <Line kind="merge-not-eligible" tone="warning">
          <span>{gt("Automatic merge on, not eligible")}</span>
          <Code>{fact.blockingReason ?? gt("no reason given")}</Code>
        </Line>
      );
    case "eligible":
      return (
        <Line kind="merge-eligible">
          <span>{gt("Automatic merge on")}</span>
        </Line>
      );
    case "problem":
      return (
        <Line kind="merge-problem" tone="warning">
          <span>{fact.problem}</span>
        </Line>
      );
  }
}

function ExecutionLine({ fact }: { fact: CardMergeExecutionFact }) {
  const gt = useGT();
  const label = {
    "in-progress": gt("Merge in progress"),
    failed: gt("Merge blocked"),
    uncertain: gt("Merge outcome uncertain"),
    waiting: gt("Merge not evaluated yet"),
    unknown: gt("Merge state"),
  }[fact.group];
  return (
    <Line
      kind={`merge-${fact.group}`}
      {...(fact.group === "failed" || fact.group === "uncertain"
        ? { tone: "warning" as const }
        : {})}
    >
      <span>{label}</span>
      <Code>{fact.reason ? `${fact.state}: ${fact.reason}` : fact.state}</Code>
    </Line>
  );
}
