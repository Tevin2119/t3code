import {
  CircleHelpIcon,
  ClockIcon,
  GitBranchIcon,
  HourglassIcon,
  MessageSquareIcon,
  PaperclipIcon,
  UserIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { nowLine, waitingWords, type DeliveryCard, type TaskPriority } from "../../lib/delivery";
import { ageLabel, initialsOf, PRIORITY_LABEL } from "../../lib/deliveryBoard";
import { harnessLabel } from "../../lib/deliverySeats";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PRIORITY_TONE: Record<TaskPriority, string> = {
  urgent: "bg-red-500/15 text-red-700 dark:text-red-300",
  high: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  medium: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  low: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
};

export function PriorityPill(props: { readonly priority: TaskPriority; readonly by?: string }) {
  const pill = (
    <span
      data-priority={props.priority}
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded px-1.5 text-[10px] font-medium tracking-wide uppercase",
        PRIORITY_TONE[props.priority],
      )}
    >
      {PRIORITY_LABEL[props.priority]}
    </span>
  );
  if (!props.by) return pill;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{pill}</TooltipTrigger>
      <TooltipPopup side="top">
        {props.by === "person"
          ? "Set by a person"
          : props.by === "triage"
            ? "Set by triage. A person may change it."
            : "The default. Triage or a person may change it."}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Lanes are told apart by colour, as the columns of a board are. */
export const LANE_TONE: Record<string, { readonly bar: string; readonly tint: string }> = {
  draft: { bar: "bg-zinc-400", tint: "bg-zinc-500/5" },
  chat: { bar: "bg-lime-500", tint: "bg-lime-500/5" },
  intake: { bar: "bg-sky-500", tint: "bg-sky-500/5" },
  triage: { bar: "bg-violet-500", tint: "bg-violet-500/5" },
  "needs-decision": { bar: "bg-amber-500", tint: "bg-amber-500/8" },
  ready: { bar: "bg-teal-500", tint: "bg-teal-500/5" },
  planning: { bar: "bg-indigo-500", tint: "bg-indigo-500/5" },
  implementation: { bar: "bg-blue-500", tint: "bg-blue-500/5" },
  validation: { bar: "bg-cyan-500", tint: "bg-cyan-500/5" },
  "human-review": { bar: "bg-fuchsia-500", tint: "bg-fuchsia-500/8" },
  paused: { bar: "bg-orange-500", tint: "bg-orange-500/5" },
  rework: { bar: "bg-rose-500", tint: "bg-rose-500/5" },
  completed: { bar: "bg-emerald-500", tint: "bg-emerald-500/5" },
};

export const laneTone = (lane: string | null) =>
  LANE_TONE[lane ?? ""] ?? { bar: "bg-zinc-400", tint: "bg-zinc-500/5" };

const AVATAR_TONES = [
  "bg-sky-600",
  "bg-violet-600",
  "bg-emerald-600",
  "bg-amber-600",
  "bg-rose-600",
  "bg-teal-600",
  "bg-indigo-600",
  "bg-fuchsia-600",
];

const toneFor = (name: string) => {
  let sum = 0;
  for (const char of name) sum = (sum * 31 + char.charCodeAt(0)) % 9973;
  return AVATAR_TONES[sum % AVATAR_TONES.length]!;
};

export function Avatar(props: {
  readonly name: string;
  readonly detail: string;
  /** A seat is shown square, a person round. */
  readonly seat?: boolean;
  readonly working?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className={cn(
              "relative inline-flex size-5 shrink-0 items-center justify-center text-[9px] font-semibold text-white",
              props.seat ? "rounded" : "rounded-full",
              toneFor(props.name),
            )}
          />
        }
      >
        {initialsOf(props.name)}
        {props.working ? (
          <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-background bg-emerald-500" />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.detail}</TooltipPopup>
    </Tooltip>
  );
}

export function TagList(props: {
  readonly tags: ReadonlyArray<string>;
  readonly onPick?: ((tag: string) => void) | undefined;
}) {
  if (props.tags.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {props.tags.map((tag) =>
        props.onPick ? (
          <button
            key={tag}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onPick?.(tag);
            }}
            className="cursor-pointer rounded bg-muted px-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            #{tag}
          </button>
        ) : (
          <span key={tag} className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
            #{tag}
          </span>
        ),
      )}
    </span>
  );
}

function Count(props: {
  readonly icon: ReactNode;
  readonly count: number;
  readonly label: string;
  readonly tone?: string;
}) {
  if (props.count <= 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className={cn(
              "inline-flex items-center gap-0.5 text-[10px] text-muted-foreground [&_svg]:size-3",
              props.tone,
            )}
          />
        }
      >
        {props.icon}
        {props.count}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

const WAITING_LABEL: Record<string, string> = {
  person: "Waiting on you",
  team: "With the team",
  clock: "Waiting to try again",
  task: "Waiting for another task",
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What is going on with a task, in the few signs a card has room for. */
export function CardSigns(props: { readonly card: DeliveryCard }) {
  const { card } = props;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-card-signs>
      {card.first ? (
        <span
          className="rounded bg-primary/15 px-1 text-[10px] font-medium text-primary"
          data-card-first
          aria-label="Next: put first for the next free slots"
        >
          Next
        </span>
      ) : null}
      {card.set === "qualification" ? (
        <span
          className="rounded border border-border px-1 text-[10px] text-muted-foreground"
          data-card-set="qualification"
        >
          Qualification
        </span>
      ) : null}
      <Count
        icon={<CircleHelpIcon />}
        count={card.questions + card.proposals}
        label={`${plural(card.questions, "question waits", "questions wait")} for your answer${
          card.proposals > 0
            ? `, and ${plural(card.proposals, "change waits", "changes wait")} to be confirmed`
            : ""
        }`}
        tone="font-medium text-amber-600 dark:text-amber-400"
      />
      <Count
        icon={<MessageSquareIcon />}
        count={card.unread}
        label={`${plural(card.unread, "message", "messages")} from the team since you last opened it`}
        tone="font-medium text-sky-600 dark:text-sky-400"
      />
      <Count
        icon={<HourglassIcon />}
        count={card.unanswered}
        label={`${plural(card.unanswered, "message", "messages")} of yours not yet taken up by the team`}
      />
      <Count
        icon={<PaperclipIcon />}
        count={card.files}
        label={plural(card.files, "file", "files")}
      />
      <Count
        icon={<GitBranchIcon />}
        count={card.parts.length}
        label={`${card.partsDelivered} of ${plural(card.parts.length, "part", "parts")} delivered`}
      />
    </span>
  );
}

export function QaVotes(props: { readonly qa: DeliveryCard["qa"] }) {
  if (!props.qa || props.qa.votes.length === 0) return null;
  const passed = props.qa.votes.filter((vote) => vote.verdict === "pass").length;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} className="inline-flex items-center gap-0.5" data-card-qa />}
      >
        {props.qa.votes.map((vote) => (
          <span
            key={vote.seat}
            className={cn(
              "size-2 rounded-full",
              vote.verdict === "pass" ? "bg-emerald-500" : "bg-rose-500",
            )}
          />
        ))}
        <span className="pl-0.5 text-[10px] text-muted-foreground">
          QA {passed}/{props.qa.needed ?? props.qa.votes.length}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.qa.votes.map((vote) => `${vote.provider}: ${vote.verdict}`).join(", ")}
        {props.qa.needed ? `. ${props.qa.needed} providers have to pass.` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Who holds the task now: the seats working on it, or who it waits for. */
export function CardPeople(props: { readonly card: DeliveryCard }) {
  const { card } = props;
  return (
    <span className="flex items-center gap-1" data-card-people>
      {card.workers.map((worker) => (
        <Avatar
          key={`${worker.seat}:${worker.stage}`}
          seat
          working={!worker.waiting}
          name={worker.harness ?? worker.seat}
          detail={`${worker.seat} on ${harnessLabel(worker.harness)} ${
            worker.waiting
              ? `${waitingWords(worker.waiting)} before ${worker.stage}${worker.waitingWhy ? `: ${worker.waitingWhy}` : ""}`
              : `is working on ${worker.stage}`
          }${worker.specialist ? ` as ${worker.specialist}` : ""}`}
        />
      ))}
      {card.owner ? <Avatar name={card.owner} detail={`Owner: ${card.owner}`} /> : null}
    </span>
  );
}

export function WaitingOn(props: { readonly card: DeliveryCard; readonly className?: string }) {
  const { card } = props;
  if (!card.waitingOn) return null;
  const onPerson = card.waitingOn === "person";
  const Icon = onPerson ? UserIcon : ClockIcon;
  return (
    <span
      data-waiting-on={card.waitingOn}
      className={cn(
        "inline-flex items-center gap-1 text-[10px] [&_svg]:size-3",
        onPerson ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground",
        props.className,
      )}
    >
      <Icon />
      {card.workers.length > 0
        ? nowLine(card)
        : card.stage && card.waitingOn === "team"
          ? `At ${card.stage}`
          : (WAITING_LABEL[card.waitingOn] ?? card.waitingOn)}
    </span>
  );
}

export function Age(props: {
  readonly at: string | null;
  readonly now: number;
  readonly label: string;
}) {
  const age = ageLabel(props.at, props.now);
  if (!age) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="text-[10px] text-muted-foreground" />}>
        {age}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.label} {props.at}
      </TooltipPopup>
    </Tooltip>
  );
}
