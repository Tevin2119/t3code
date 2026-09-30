/**
 * What the board and the task workspace work out for themselves: how a card
 * is labelled, which cards a search keeps, and how a file is cut up to be
 * sent. Where a card may go is the engine's to decide; `laneAccepts` only
 * says which lanes are worth offering while a card is dragged.
 */
import type { DeliveryCard, DeliveryLane, TaskPriority } from "./delivery";

export const PRIORITY_LABEL: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const PRIORITY_ORDER: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** How long ago, in the shortest form that still tells a day from a week. */
export function ageLabel(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  if (days < 70) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function initialsOf(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

export interface BoardFilters {
  readonly q: string;
  readonly priority: TaskPriority | null;
  readonly team: string | null;
  readonly tag: string | null;
  readonly owner: string | null;
  /** Only what waits for a person. */
  readonly waiting: boolean;
  /** Only these columns of the board, by the names the engine gives them. None: every column. */
  readonly lanes: ReadonlyArray<string>;
}

export const NO_FILTERS: BoardFilters = {
  q: "",
  priority: null,
  team: null,
  tag: null,
  owner: null,
  waiting: false,
  lanes: [],
};

export const hasFilters = (filters: BoardFilters): boolean =>
  filters.q.trim() !== "" ||
  filters.priority !== null ||
  filters.team !== null ||
  filters.tag !== null ||
  filters.owner !== null ||
  filters.waiting ||
  filters.lanes.length > 0;

/**
 * Whether a card is kept by a search. A number, with or without `#`, finds
 * the task of that number; words are looked for in the title, the tags, the
 * owner, the team and the id, and all of them have to be found.
 */
export function matchesCard(card: DeliveryCard, filters: BoardFilters): boolean {
  if (filters.priority && card.priority !== filters.priority) return false;
  if (filters.team && card.team !== filters.team) return false;
  if (filters.tag && !card.tags.includes(filters.tag)) return false;
  if (filters.owner && card.owner.toLowerCase() !== filters.owner.toLowerCase()) return false;
  if (filters.waiting && card.waitingOn !== "person") return false;
  if (filters.lanes.length > 0 && !filters.lanes.includes(card.lane)) return false;
  const q = filters.q.trim().toLowerCase();
  if (!q) return true;
  const number = /^#?(\d+)$/.exec(q)?.[1];
  if (number) {
    return (
      String(card.number).includes(number) ||
      card.parts.some((part) => String(part.number).includes(number))
    );
  }
  const hay = [
    `#${card.number}`,
    card.id,
    card.title,
    card.team,
    card.owner,
    card.stage ?? "",
    ...card.tags,
    ...card.workers.map((worker) => `${worker.seat} ${worker.harness ?? ""}`),
    ...card.parts.map((part) => part.title),
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

export function filterLanes(
  lanes: ReadonlyArray<DeliveryLane>,
  filters: BoardFilters,
): ReadonlyArray<DeliveryLane> {
  if (!hasFilters(filters)) return lanes;
  // Columns that were not chosen are not shown at all.
  const shown =
    filters.lanes.length > 0 ? lanes.filter((lane) => filters.lanes.includes(lane.lane)) : lanes;
  return shown.map((lane) => ({
    ...lane,
    cards: lane.cards.filter((card) => matchesCard(card, filters)),
  }));
}

/** A filter that is on, as a person reads it, with what turns it off. */
export interface ActiveFilter {
  readonly key: string;
  readonly label: string;
  readonly clear: Partial<BoardFilters>;
}

/** Every filter that is on, in words, so that what is hidden is never a surprise. */
export function activeFilters(
  filters: BoardFilters,
  laneTitle: (lane: string) => string,
): ReadonlyArray<ActiveFilter> {
  const found: ActiveFilter[] = [];
  const q = filters.q.trim();
  if (q) found.push({ key: "q", label: `"${q}"`, clear: { q: "" } });
  if (filters.waiting)
    found.push({ key: "waiting", label: "Waiting on you", clear: { waiting: false } });
  for (const lane of filters.lanes) {
    found.push({
      key: `lane:${lane}`,
      label: laneTitle(lane),
      clear: { lanes: filters.lanes.filter((item) => item !== lane) },
    });
  }
  if (filters.priority)
    found.push({
      key: "priority",
      label: `${PRIORITY_LABEL[filters.priority]} priority`,
      clear: { priority: null },
    });
  if (filters.team)
    found.push({ key: "team", label: `Team ${filters.team}`, clear: { team: null } });
  if (filters.tag) found.push({ key: "tag", label: `#${filters.tag}`, clear: { tag: null } });
  if (filters.owner)
    found.push({ key: "owner", label: `Owner ${filters.owner}`, clear: { owner: null } });
  return found;
}

/**
 * What starting a task does, in words, for its flow. Starting is the one way a task comes onto
 * the Board: a message in a thread never makes one. The Orchestrator's composer says it for
 * Start, the task form for Submit.
 */
export function whatStartDoes(flow: string, verb: "Start" | "Submit"): string {
  const then: Readonly<Record<string, string>> = {
    chat: "a Team chat task on the Board (under Team chats). The team talks it over; nothing is built.",
    plan: "a task on the Board. It is triaged and planned, and stops at the plan for you to read. Nothing is built until you start the delivery.",
    review:
      "a task on the Board. The seats examine what is there and write down what they find. Nothing is changed.",
    standard:
      "a task on the Board. It is triaged, planned, built, checked, reviewed and tested, and stops at Your sign-off for your decision. Nothing is merged.",
  };
  return `${verb} makes ${then[flow] ?? then.standard} Saving keeps it as a draft, which runs nothing.`;
}

/**
 * Which board is shown: a board a person made, "unsorted" (tasks on no board), the
 * qualification's, or "all". The engine lists them; "pilot" is the earlier name of "unsorted".
 */
export const boardSetOf = (stored: string): string =>
  stored === "pilot" || !stored ? "unsorted" : stored;
/** Boards that come with every engine, which a new task is not filed onto. */
export const BUILT_IN_BOARDS: ReadonlyArray<string> = ["unsorted", "qualification", "all"];

export const BOARD_GROUPINGS = ["none", "priority", "team", "owner", "tag"] as const;
export type BoardGrouping = (typeof BOARD_GROUPINGS)[number];

export const GROUPING_LABEL: Record<BoardGrouping, string> = {
  none: "No grouping",
  priority: "Priority",
  team: "Team",
  owner: "Owner",
  tag: "First tag",
};

/** The cards of a lane in groups, in the order the lane has them. */
export function groupCards(
  cards: ReadonlyArray<DeliveryCard>,
  grouping: BoardGrouping,
): ReadonlyArray<{
  readonly key: string;
  readonly title: string | null;
  readonly cards: ReadonlyArray<DeliveryCard>;
}> {
  if (grouping === "none") return [{ key: "all", title: null, cards }];
  const keyOf = (card: DeliveryCard): string =>
    grouping === "priority"
      ? card.priority
      : grouping === "team"
        ? card.team
        : grouping === "owner"
          ? card.owner || "nobody"
          : (card.tags[0] ?? "untagged");
  const groups = new Map<string, DeliveryCard[]>();
  for (const card of cards) {
    const key = keyOf(card);
    const group = groups.get(key);
    if (group) group.push(card);
    else groups.set(key, [card]);
  }
  const keys = [...groups.keys()];
  if (grouping === "priority") {
    keys.sort((a, b) => PRIORITY_ORDER[a as TaskPriority] - PRIORITY_ORDER[b as TaskPriority]);
  } else keys.sort((a, b) => a.localeCompare(b));
  return keys.map((key) => ({
    key,
    title: grouping === "priority" ? PRIORITY_LABEL[key as TaskPriority] : key,
    cards: groups.get(key)!,
  }));
}

/**
 * What dropping a card on a lane would ask of the engine, or null where the
 * engine is known to refuse. The engine answers the request either way.
 */
export function laneAccepts(
  card: Pick<DeliveryCard, "lane" | "held" | "submitted" | "state">,
  lane: string,
): string | null {
  if (lane === card.lane) return "Reorder";
  if (card.lane === "draft") return lane === "intake" || lane === "triage" ? "Submit" : null;
  if (lane === "draft") return null;
  if (card.lane === "completed") return null;
  // A chat, a plan that is ready and a review that is ready are not moved by hand.
  if (card.lane === "chat" || lane === "chat") return null;
  if (["planned", "reviewed"].includes(card.state)) return null;
  if (lane === "paused") return "Pause";
  if (card.lane === "paused" && card.held) return "Resume";
  if (lane === "intake" || lane === "triage") {
    return card.submitted ? "Send to triage again" : "Submit";
  }
  return null;
}

export type FileKind = "image" | "video" | "audio" | "text" | "pdf" | "other";

export function fileKindOf(type: string, name: string): FileKind {
  const kind = type.toLowerCase();
  if (kind.startsWith("image/")) return "image";
  if (kind.startsWith("video/")) return "video";
  if (kind.startsWith("audio/")) return "audio";
  if (kind === "application/pdf") return "pdf";
  if (
    kind.startsWith("text/") ||
    kind === "application/json" ||
    /\.(txt|md|log|json|ya?ml|csv|tsv|xml|html?|css|[cm]?[jt]sx?|py|rs|go|java|sh|ps1|sql|toml|ini|diff|patch)$/i.test(
      name,
    )
  ) {
    return "text";
  }
  return "other";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1048576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

/** The engine takes a file of up to 200 MB, in pieces. */
export const TASK_FILE_LIMIT_BYTES = 200 * 1024 * 1024;
/** Small enough to pass as one message over a relay, large enough to be quick. */
export const TASK_FILE_PIECE_BYTES = 512 * 1024;

/** Where each piece of a file of this size starts and ends. An empty file is one empty piece. */
export function piecesOf(
  size: number,
  piece = TASK_FILE_PIECE_BYTES,
): ReadonlyArray<{ readonly from: number; readonly to: number; readonly last: boolean }> {
  if (size <= 0) return [{ from: 0, to: 0, last: true }];
  const out: Array<{ from: number; to: number; last: boolean }> = [];
  for (let from = 0; from < size; from += piece) {
    const to = Math.min(size, from + piece);
    out.push({ from, to, last: to >= size });
  }
  return out;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/webm": "webm",
  "video/mp4": "mp4",
  "audio/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "text/plain": "txt",
};

/**
 * A name for what was pasted. A screenshot from the clipboard arrives as
 * `image.png` every time, so it is named by what it is and when it came.
 */
export function pastedFileName(file: { readonly name: string; readonly type: string }, at: Date) {
  const generic = /^(image|blob|file|clipboard|untitled|audio|video|recording)?(\.\w+)?$/i.test(
    file.name.trim(),
  );
  if (file.name.trim() && !generic) return file.name.trim();
  const kind = fileKindOf(file.type, file.name);
  const word =
    kind === "image"
      ? "screenshot"
      : kind === "video"
        ? "screen-recording"
        : kind === "audio"
          ? "voice-recording"
          : "pasted";
  const extension =
    EXTENSION_BY_TYPE[file.type.toLowerCase().split(";")[0]!] ??
    /\.(\w+)$/.exec(file.name)?.[1] ??
    "bin";
  const stamp = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, "0")}${String(at.getDate()).padStart(2, "0")}-${String(at.getHours()).padStart(2, "0")}${String(at.getMinutes()).padStart(2, "0")}${String(at.getSeconds()).padStart(2, "0")}`;
  return `${word}-${stamp}.${extension}`;
}

/** Tags as typed: separated by commas or spaces, without `#`, each once. */
export function tagsFromText(value: string): ReadonlyArray<string> {
  return [
    ...new Set(
      value
        .split(/[,\s]+/)
        .map((tag) => tag.trim().replace(/^#/, "").toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 12);
}

/** One entry to a line, without the bullet a person may have typed. */
export function linesFromText(value: string): ReadonlyArray<string> {
  return value
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

export const FLOW_LABEL: Readonly<Record<string, string>> = {
  chat: "Chat",
  plan: "Plan",
  review: "Review",
  standard: "Delivery",
};

export type ComposerKind = "message" | "status" | "change" | "note" | "answer";

export const COMPOSER_KIND_LABEL: Record<ComposerKind, string> = {
  message: "Discuss with the team",
  answer: "Answer a question",
  status: "Ask for status",
  change: "Request a requirements change",
  note: "Add a note",
};

/**
 * What sending does, said beside the composer on every screen. `moves` is whether the work
 * of the task may move because of it. A message is never an approval: that is a decision of
 * its own, made with the buttons for it.
 */
export const COMPOSER_EFFECT: Record<
  ComposerKind,
  { readonly label: string; readonly moves: boolean }
> = {
  message: {
    label: "Asks the team for a reply. Nothing is approved or changed by it.",
    moves: false,
  },
  answer: {
    label: "Answers the question that waits. The work that waited for it goes on.",
    moves: true,
  },
  status: { label: "Answered from the record at once. Nothing changes.", moves: false },
  change: {
    label:
      "Changes what is asked: a new revision, earlier approvals end, and the task goes back to triage.",
    moves: true,
  },
  note: { label: "Recorded only. Nobody is asked to do anything.", moves: false },
};

export const COMPOSER_KIND_HELP: Record<ComposerKind, string> = {
  message:
    "Read by the team's coordinator, which answers, or proposes a change for you to confirm. It never approves anything.",
  answer: "Goes to the question that waits. The task takes it up and goes on from triage.",
  status: "Answered at once from the engine's record. No model reads it and nothing changes.",
  change:
    "Becomes a new revision of the task, ends earlier approvals, and sends the task back to triage.",
  note: "Kept in the history. The team is not asked to do anything with it.",
};

/** Whether the send key was pressed, by the person's own setting for it. */
export function isSendKey(
  event: {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly isComposing?: boolean;
  },
  sendShortcut: "enter" | "mod-enter-multiline" | "mod-enter",
  text: string,
): boolean {
  if (event.key !== "Enter" || event.isComposing) return false;
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier) return true;
  if (event.shiftKey) return false;
  if (sendShortcut === "mod-enter") return false;
  if (sendShortcut === "mod-enter-multiline") return !text.includes("\n");
  return true;
}

/** A value for the query of an engine path, in the characters such a path may carry. */
export function queryValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .slice(0, 300);
}

export const LANE_TITLE: Readonly<Record<string, string>> = {
  draft: "Draft",
  chat: "Team chat",
  intake: "Intake",
  triage: "Triage",
  "needs-decision": "Waiting on you",
  ready: "Ready",
  planning: "Planning",
  implementation: "Building",
  validation: "Testing",
  "human-review": "Your sign-off",
  paused: "Paused or recovering",
  rework: "Rework",
  approved: "Approved, not published",
  "pull-request": "Pull request open",
  completed: "Done",
};

/** What became of a message a person sent, in words a person would use. */
export function messageStateLabel(state: string | null, revision: number | null): string | null {
  switch (state) {
    case "received":
      return "Sent. Not read by the team yet";
    case "seen":
      return "Seen by the team";
    case "answered":
      return "Answered";
    case "applied":
      return revision ? `Taken into the task as revision ${revision}` : "Taken into the task";
    case "proposed":
      return "Read as a change. It waits for you to confirm it";
    case "noted":
      return "Kept for the record";
    case "confirmed":
      return "Confirmed";
    case "declined":
      return "Declined";
    case "closed":
      return "No longer waiting";
    case "open":
      return "Waiting for your answer";
    default:
      return null;
  }
}

/** The engine's id of a task, which is what an address carries. */
export const isTaskId = (value: unknown): value is string =>
  typeof value === "string" && /^(task|thread)-[0-9a-f]{6,32}$/.test(value);

/** A conversation of the window, as an address carries it: `<environment>/<thread>`. */
export const isConversationRef = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][\w.-]{0,79}\/[A-Za-z0-9][\w.-]{0,79}$/.test(value);

/** How much of one message goes into a task made from a conversation. */
const QUOTE_LIMIT = 2000;
const quoted = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > QUOTE_LIMIT ? `${trimmed.slice(0, QUOTE_LIMIT)}…` : trimmed;
};

/**
 * A task drafted from a conversation, for a person to review before anything is asked of
 * anyone: what was first asked, where the conversation ended, and what was asked since. It is
 * a starting point, written from the conversation as it stands, and names where it came from.
 */
export function taskFromConversation(input: {
  readonly title: string;
  readonly ref: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
}): { readonly title: string; readonly text: string } {
  const spoken = input.messages.filter(
    (message) => (message.role === "user" || message.role === "assistant") && message.text.trim(),
  );
  const asked = spoken.filter((message) => message.role === "user");
  const lastAnswer = spoken.filter((message) => message.role === "assistant").at(-1) ?? null;
  const later = asked.slice(1).map((message) => message.text.trim().split("\n")[0]!.slice(0, 200));
  const sections = [
    `Made from the conversation "${input.title}" (${input.ref}). Written from the conversation as it stands: read it and change what is not right before saving. Nothing is asked of a team until the task is submitted.`,
    ...(asked[0] ? ["## What was asked", quoted(asked[0].text)] : []),
    ...(later.length
      ? [
          "## Asked since",
          later
            .slice(-8)
            .map((line) => `- ${line}`)
            .join("\n"),
        ]
      : []),
    ...(lastAnswer ? ["## Where the conversation ended", quoted(lastAnswer.text)] : []),
  ];
  return { title: input.title.trim().slice(0, 120), text: sections.join("\n\n") };
}
