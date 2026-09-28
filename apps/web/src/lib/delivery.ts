/**
 * What the delivery engine sends, read defensively. The server relays the
 * engine's JSON untyped so the engine can change without a contract change;
 * everything here narrows it and drops what it cannot read, so an engine
 * newer or older than this client degrades to missing detail, not a crash.
 */
import {
  DELIVERY_HARNESS_BY_DRIVER,
  type DeliveryThreadBinding,
  type ThreadId,
} from "@t3tools/contracts";

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const flag = (value: unknown): boolean => value === true;
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const records = (value: unknown): ReadonlyArray<Json> => list(value).filter(isRecord);
const strings = (value: unknown): ReadonlyArray<string> =>
  list(value).filter((item): item is string => typeof item === "string");

export interface DeliverySeat {
  readonly seat: string;
  readonly title: string;
  /** Stages of the flow this seat works in. */
  readonly stages: ReadonlyArray<string>;
  /** Whether its verdict counts at the QA gate. */
  readonly inGate: boolean;
  readonly role: string;
  readonly harness: string;
  readonly model: string | null;
  readonly provider: string;
  readonly required: boolean;
  readonly available: boolean;
  readonly why: string | null;
  readonly tools: ReadonlyArray<string>;
}

export interface DeliveryTeam {
  readonly team: string;
  readonly purpose: string;
  readonly configuration: string;
  readonly available: boolean;
  readonly why: string | null;
  readonly seats: ReadonlyArray<DeliverySeat>;
  readonly specialists: ReadonlyArray<string>;
  /** Every role the team has written down. Any of them can be chosen for a harness. */
  readonly roles: ReadonlyArray<DeliveryRole>;
  readonly settings: ReadonlyArray<SeatSettings>;
  readonly workflows: ReadonlyArray<DeliveryWorkflow>;
  /** What a person saved as the team's defaults. Revision 0 is the definition itself. */
  readonly defaults: {
    readonly revision: number;
    readonly by: string | null;
    readonly at: string | null;
    readonly problems: ReadonlyArray<string>;
  };
  /** The share of the builds each build seat takes, as set and as the team defines it. */
  readonly workload: {
    readonly build: Readonly<Record<string, number>>;
    readonly defined: Readonly<Record<string, number>>;
  };
  readonly qaGate: { readonly seats: ReadonlyArray<string>; readonly minimum: number } | null;
}

export interface DeliveryRole {
  readonly role: string;
  readonly title: string;
  readonly summary: string;
  /** Harnesses whose own seat holds this role. */
  readonly harnesses: ReadonlyArray<string>;
}

export interface DeliveryWorkflow {
  readonly id: string;
  readonly title: string;
  readonly stages: ReadonlyArray<string>;
  readonly stop: string;
}

export const SEAT_SETTING_KEYS = ["harness", "model", "reasoning", "access"] as const;
export type SeatSettingKey = (typeof SEAT_SETTING_KEYS)[number];
/** What a person chose for a seat. A key left out runs as the team has it. */
export type SeatChoice = Partial<Record<SeatSettingKey, string>>;

export interface SeatSettingValues {
  readonly harness: string | null;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly access: string | null;
}

/** What one harness takes from outside. */
export interface SeatOffer {
  readonly model: boolean;
  readonly reasoning: ReadonlyArray<string>;
  readonly access: ReadonlyArray<string>;
}

/** What may be set for one seat, what the team has it on, and what is set for a task. */
export interface SeatSettings {
  readonly seat: string;
  readonly title: string;
  readonly role: string;
  readonly harness: string;
  readonly provider: string;
  /** What the team's definition says, before anybody saved defaults. */
  readonly defined: SeatSettingValues;
  /** The team default: the definition with the saved defaults laid over it. */
  readonly now: SeatSettingValues;
  readonly saved: SeatChoice;
  /** Models the team names for this seat, offered first. */
  readonly models: ReadonlyArray<string>;
  readonly may: SeatOffer & { readonly harness: ReadonlyArray<string> };
  /** What each harness would take, for the choices after a seat is moved to it. */
  readonly byHarness: Readonly<Record<string, SeatOffer>>;
  readonly why: SeatSettingValues;
  readonly set: SeatChoice;
  readonly effective: SeatSettingValues;
}

const parseValues = (value: unknown, harness: string | null = null): SeatSettingValues => {
  const from = isRecord(value) ? value : {};
  return {
    harness: textOrNull(from.harness) ?? harness,
    model: textOrNull(from.model),
    reasoning: textOrNull(from.reasoning),
    access: textOrNull(from.access),
  };
};

const parseOffer = (value: unknown): SeatOffer => {
  const from = isRecord(value) ? value : {};
  return {
    model: flag(from.model),
    reasoning: strings(from.reasoning),
    access: strings(from.access),
  };
};

const parseChoice = (value: unknown): SeatChoice => {
  const from = isRecord(value) ? value : {};
  return Object.fromEntries(
    SEAT_SETTING_KEYS.filter((key) => typeof from[key] === "string" && from[key] !== "").map(
      (key) => [key, String(from[key])],
    ),
  );
};

export const parseSeatSettings = (value: Json): SeatSettings => {
  const may = isRecord(value.may) ? value.may : {};
  const harness = text(value.harness);
  const now = parseValues(value.now, harness);
  const byHarness = isRecord(value.byHarness) ? value.byHarness : {};
  return {
    seat: text(value.seat),
    title: text(value.title, text(value.seat)),
    role: text(value.role),
    harness,
    provider: text(value.provider),
    defined: value.defined === undefined ? now : parseValues(value.defined, harness),
    now,
    saved: parseChoice(value.saved),
    models: strings(value.models),
    may: { ...parseOffer(may), harness: strings(may.harness) },
    byHarness: Object.fromEntries(
      Object.entries(byHarness).map(([name, offer]) => [name, parseOffer(offer)]),
    ),
    why: parseValues(value.why),
    set: parseChoice(value.set),
    effective: value.effective === undefined ? now : parseValues(value.effective, harness),
  };
};

/** What can be chosen for a seat once it runs on the harness chosen for it. */
export function seatOfferFor(item: SeatSettings, choice: SeatChoice): SeatOffer {
  const harness = choice.harness ?? item.now.harness ?? item.harness;
  if (harness === (item.now.harness ?? item.harness)) return item.may;
  return item.byHarness[harness] ?? { model: false, reasoning: [], access: [] };
}

/**
 * A seat moved to a harness with a model. What was chosen for the harness it
 * left is kept only where the new harness takes it too.
 */
export function moveSeat(
  item: SeatSettings,
  choice: SeatChoice,
  to: { readonly harness: string; readonly model: string | null },
): SeatChoice {
  const offer = seatOfferFor(item, { harness: to.harness });
  const next: SeatChoice = { harness: to.harness };
  if (to.model && offer.model) next.model = to.model;
  if (choice.reasoning && offer.reasoning.includes(choice.reasoning)) {
    next.reasoning = choice.reasoning;
  }
  if (choice.access && offer.access.includes(choice.access)) next.access = choice.access;
  return next;
}

const parseWorkflows = (value: unknown): ReadonlyArray<DeliveryWorkflow> =>
  records(value).map((item) => ({
    id: text(item.id),
    title: text(item.title, text(item.id)),
    stages: strings(item.stages),
    stop: text(item.stop),
  }));

const shares = (value: unknown): Record<string, number> =>
  Object.fromEntries(
    Object.entries(isRecord(value) ? value : {})
      .filter(([, share]) => typeof share === "number" && Number.isFinite(share))
      .map(([seat, share]) => [seat, share as number]),
  );

const parseSeat = (value: Json): DeliverySeat => ({
  seat: text(value.seat),
  title: text(value.title, text(value.seat)),
  stages: strings(value.stages),
  inGate: flag(value.inGate),
  role: text(value.role),
  harness: text(value.harness),
  model: textOrNull(value.model),
  provider: text(value.provider),
  required: flag(value.required),
  available: flag(value.available),
  why: textOrNull(value.why),
  tools: strings(value.tools),
});

const parseTeam = (team: Json): DeliveryTeam => {
  const defaults = isRecord(team.defaults) ? team.defaults : {};
  const workload = isRecord(team.workload) ? team.workload : {};
  const gates = isRecord(team.gates) ? team.gates : {};
  const qa = isRecord(gates.qa) ? gates.qa : null;
  return {
    team: text(team.team),
    purpose: text(team.purpose),
    configuration: text(team.configuration),
    available: flag(team.available),
    why: textOrNull(team.why),
    seats: records(team.seats).map(parseSeat),
    specialists: strings(team.specialists),
    roles: records(team.roles).map((role) => ({
      role: text(role.role),
      title: text(role.title, text(role.role)),
      summary: text(role.summary),
      harnesses: strings(role.harnesses),
    })),
    settings: records(team.settings).map(parseSeatSettings),
    workflows: parseWorkflows(team.workflows),
    defaults: {
      revision: count(defaults.revision),
      by: textOrNull(defaults.by),
      at: textOrNull(defaults.at),
      problems: strings(defaults.problems),
    },
    workload: { build: shares(workload.build), defined: shares(workload.defined) },
    qaGate: qa ? { seats: strings(qa.seats), minimum: count(qa.minimumPassingProviders) } : null,
  };
};

export function parseTeams(body: unknown): ReadonlyArray<DeliveryTeam> {
  return records(body)
    .filter((team) => text(team.team).length > 0)
    .map(parseTeam);
}

export interface TeamDefaults {
  readonly team: DeliveryTeam;
  /** Every saving, newest first. */
  readonly history: ReadonlyArray<{
    readonly revision: number;
    readonly by: string;
    readonly at: string;
    readonly note: string | null;
    readonly seats: Readonly<Record<string, SeatChoice>>;
    readonly workload: Readonly<Record<string, number>>;
  }>;
  /** What the engine said about the saving, e.g. that runs under way keep what they have. */
  readonly note: string | null;
}

export function parseTeamDefaults(body: unknown): TeamDefaults | null {
  if (!isRecord(body) || text(body.team).length === 0) return null;
  return {
    team: parseTeam(body),
    history: records(body.history).map((row) => ({
      revision: count(row.revision),
      by: text(row.by),
      at: text(row.at),
      note: textOrNull(row.note),
      seats: Object.fromEntries(
        Object.entries(isRecord(row.seats) ? row.seats : {}).map(([seat, choice]) => [
          seat,
          parseChoice(choice),
        ]),
      ),
      workload: shares(isRecord(row.workload) ? row.workload.build : null),
    })),
    note: textOrNull(body.note),
  };
}

/**
 * The roles a harness can be given in a team: every role of the team, with
 * the ones the harness's own seats hold first. `held` is what is taken when
 * the person chooses nothing, and is null when that is not one clear role.
 */
export function rolesForHarness(
  team: DeliveryTeam,
  harness: string,
): { readonly roles: ReadonlyArray<DeliveryRole>; readonly held: string | null } {
  const own = [
    ...new Set(team.seats.filter((seat) => seat.harness === harness).map((seat) => seat.role)),
  ];
  const known = team.roles.length
    ? team.roles
    : // An engine that does not list roles: the ones the seats hold are all that is known.
      [...new Set(team.seats.map((seat) => seat.role))].map((role) => ({
        role,
        title: role,
        summary: "",
        harnesses: [],
      }));
  const roles = [
    ...known.filter((role) => own.includes(role.role)),
    ...known.filter((role) => !own.includes(role.role)),
  ];
  return { roles, held: own.length === 1 ? own[0]! : null };
}

export type TeamChoice =
  | { readonly state: "manual" }
  | { readonly state: "ready"; readonly team: string; readonly role: string }
  | { readonly state: "choose-role"; readonly team: string; readonly roles: ReadonlyArray<string> }
  | { readonly state: "blocked"; readonly team: string; readonly why: string };

/**
 * What choosing a team for a harness comes to. `manual` means no team: the
 * thread is an ordinary one. `blocked` must stop the send: sending anyway
 * would start an ordinary thread under a team's name.
 */
export function resolveTeamChoice(input: {
  readonly teams: ReadonlyArray<DeliveryTeam>;
  readonly team: string | null;
  readonly role: string | null;
  readonly driver: string | null;
}): TeamChoice {
  if (!input.team) return { state: "manual" };
  const team = input.teams.find((candidate) => candidate.team === input.team);
  if (!team) return { state: "blocked", team: input.team, why: "This team is not set up." };
  const harness = input.driver ? DELIVERY_HARNESS_BY_DRIVER[input.driver] : undefined;
  if (!harness) {
    return {
      state: "blocked",
      team: team.team,
      why: "Teams are not set up for this harness. Choose another harness, or No team.",
    };
  }
  const { roles, held } = rolesForHarness(team, harness);
  const names = roles.map((role) => role.role);
  // A role left over from another team is not taken for a choice.
  const wanted = input.role && names.includes(input.role) ? input.role : null;
  const role = wanted ?? held;
  if (!role) return { state: "choose-role", team: team.team, roles: names };
  // Whether the harness is installed is known from any seat that runs on it.
  const onHarness = team.seats.find((seat) => seat.harness === harness);
  if (onHarness && !onHarness.available) {
    return {
      state: "blocked",
      team: team.team,
      why: onHarness.why ?? "This harness cannot be started.",
    };
  }
  return { state: "ready", team: team.team, role };
}

export interface TeamProfile {
  readonly team: string;
  readonly purpose: string;
  readonly configuration: string;
  readonly role: string;
  readonly harness: string | null;
  readonly heldByASeat: boolean;
  readonly layers: ReadonlyArray<{
    readonly name: string;
    readonly source: string;
    /** Null for the repository's own rules, which the harness reads by itself. */
    readonly text: string | null;
  }>;
  readonly tools: ReadonlyArray<{
    readonly server: string;
    readonly offers: ReadonlyArray<string>;
    readonly runsAs: string;
    readonly onlyWith: string | null;
    readonly route: string;
  }>;
  readonly specialists: ReadonlyArray<{ readonly name: string; readonly text: string }>;
  readonly specialistsStartedBy: string | null;
  readonly stages: ReadonlyArray<string>;
  readonly memoryScope: string;
  readonly qaGate: { readonly seats: ReadonlyArray<string>; readonly minimum: number } | null;
}

export function parseTeamProfile(body: unknown): TeamProfile | null {
  if (!isRecord(body) || !Array.isArray(body.layers)) return null;
  const gates = isRecord(body.gates) ? body.gates : {};
  const qa = isRecord(gates.qa) ? gates.qa : null;
  return {
    team: text(body.team),
    purpose: text(body.purpose),
    configuration: text(body.configuration),
    role: text(body.role),
    harness: textOrNull(body.harness),
    heldByASeat: flag(body.heldByASeat),
    layers: records(body.layers).map((layer) => ({
      name: text(layer.name),
      source: text(layer.source),
      text: textOrNull(layer.text),
    })),
    tools: records(body.tools).map((tool) => ({
      server: text(tool.server),
      offers: strings(tool.offers),
      runsAs: text(tool.runsAs),
      onlyWith: textOrNull(tool.onlyWith),
      route: text(tool.route),
    })),
    specialists: records(body.specialists).map((item) => ({
      name: text(item.name),
      text: text(item.text),
    })),
    specialistsStartedBy: textOrNull(body.specialistsStartedBy),
    stages: strings(body.stages),
    memoryScope: text(body.memoryScope),
    qaGate: qa ? { seats: strings(qa.seats), minimum: count(qa.minimumPassingProviders) } : null,
  };
}

/**
 * Only what differs from the team default is sent. `against` is what the
 * choices are laid over: the team default for a task, the team's definition
 * for the defaults themselves. A seat moved to another harness is sent with
 * its model, which the engine asks for.
 */
export function seatSettingsToSend(
  settings: ReadonlyArray<SeatSettings>,
  chosen: Readonly<Record<string, SeatChoice>>,
  against: "now" | "defined" = "now",
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const item of settings) {
    const asked = chosen[item.seat] ?? {};
    const base = item[against];
    const harness = asked.harness?.trim();
    const moved = Boolean(harness) && harness !== (base.harness ?? item.harness);
    const kept = SEAT_SETTING_KEYS.flatMap((key): Array<[string, string]> => {
      const value = asked[key]?.trim();
      if (!value) return [];
      if (key === "harness") return moved ? [[key, value]] : [];
      return moved || value !== (base[key] ?? "") ? [[key, value]] : [];
    });
    if (kept.length > 0) out[item.seat] = Object.fromEntries(kept);
  }
  return out;
}

/** The label of a thread's team. A thread that was never bound says so. */
export function describeBinding(binding: DeliveryThreadBinding | null | undefined): {
  readonly label: string;
  readonly detail: string;
  readonly managed: boolean;
} {
  if (!binding) {
    return {
      label: "Manual / legacy",
      detail: "This thread was started without a team. It has no team instructions or tools.",
      managed: false,
    };
  }
  return {
    label: `${binding.team} · ${binding.role}`,
    detail: `Team ${binding.team}, role ${binding.role}, setup ${binding.configuration}. Pinned when the thread started.`,
    managed: true,
  };
}

export const TASK_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

const priorityOf = (value: unknown): TaskPriority =>
  TASK_PRIORITIES.find((priority) => priority === value) ?? "medium";

/** A task named on another task: a part, a follow-up, a link. */
export interface TaskBrief {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly lane: string | null;
}

const parseBrief = (value: Json): TaskBrief => ({
  id: text(value.id),
  number: count(value.number),
  title: text(value.title),
  state: text(value.state),
  lane: textOrNull(value.lane),
});

export interface DeliveryWorker {
  readonly seat: string;
  readonly harness: string | null;
  readonly role: string | null;
  readonly stage: string;
  readonly specialist: string | null;
  readonly since: string | null;
}

export interface DeliveryCard {
  readonly id: string;
  /** The number a person says and searches by, e.g. 1001. */
  readonly number: number;
  readonly title: string;
  readonly team: string;
  readonly lane: string;
  readonly state: string;
  readonly revision: number;
  readonly origin: string;
  readonly owner: string;
  readonly priority: TaskPriority;
  /** `person` when a person set it, else who did: triage, or the default. */
  readonly priorityBy: string;
  readonly tags: ReadonlyArray<string>;
  readonly deadline: string | null;
  readonly created: string;
  readonly updated: string;
  readonly submitted: string | null;
  readonly held: boolean;
  readonly parts: ReadonlyArray<TaskBrief>;
  readonly partsDelivered: number;
  readonly followUps: ReadonlyArray<TaskBrief>;
  readonly run: {
    readonly id: string;
    readonly state: string;
    readonly stage: string;
    readonly candidate: string | null;
    readonly configuration: string;
  } | null;
  /** The stage being worked in now, or null when nothing is. */
  readonly stage: string | null;
  /** Seats working on it at this moment. */
  readonly workers: ReadonlyArray<DeliveryWorker>;
  readonly paused: {
    readonly kind: string;
    readonly why: string;
    readonly nextTry: string | null;
    readonly needsPerson: boolean;
  } | null;
  readonly qa: {
    readonly votes: ReadonlyArray<{
      readonly seat: string;
      readonly provider: string;
      readonly verdict: string;
    }>;
    readonly needed: number | null;
  } | null;
  readonly findings: { readonly open: number; readonly all: number };
  readonly approvals: ReadonlyArray<{
    readonly actor: string;
    readonly decision: string;
    readonly stands: boolean;
  }>;
  /** Questions of the team that wait for a person. */
  readonly questions: number;
  readonly proposals: number;
  readonly waitsFor: ReadonlyArray<TaskBrief>;
  readonly messages: number;
  /** Said by the team or the engine since a person last opened the task. */
  readonly unread: number;
  /** Said by a person and not yet taken up. */
  readonly unanswered: number;
  readonly files: number;
  readonly last: {
    readonly at: string;
    readonly by: string;
    readonly from: string;
    readonly kind: string;
    readonly text: string;
  } | null;
  readonly blocker: string | null;
  /** `person`, `team`, `clock`, `task`, or null for a closed task. */
  readonly waitingOn: string | null;
  readonly actions: ReadonlyArray<string>;
}

export interface DeliveryLane {
  readonly lane: string;
  readonly title: string;
  readonly cards: ReadonlyArray<DeliveryCard>;
}

export interface DeliveryBoard {
  readonly view: string;
  readonly views: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly teams: ReadonlyArray<string>;
  readonly lanes: ReadonlyArray<DeliveryLane>;
  /** Cards that wait for a person. */
  readonly waiting: number;
  readonly notices: ReadonlyArray<{
    readonly key: string;
    readonly kind: string;
    readonly text: string;
    readonly count: number;
  }>;
  readonly note: string | null;
}

export const parseCard = (value: Json): DeliveryCard => {
  const run = isRecord(value.run) ? value.run : null;
  const paused = isRecord(value.paused) ? value.paused : null;
  const findings = isRecord(value.findings) ? value.findings : {};
  const qa = isRecord(value.qa) ? value.qa : null;
  const last = isRecord(value.last) ? value.last : null;
  return {
    id: text(value.id),
    number: count(value.number),
    title: text(value.title),
    team: text(value.team),
    lane: text(value.lane),
    state: text(value.state),
    revision: count(value.revision),
    origin: text(value.origin),
    owner: text(value.owner),
    priority: priorityOf(value.priority),
    priorityBy: text(value.priorityBy, "default"),
    tags: strings(value.tags),
    deadline: textOrNull(value.deadline),
    created: text(value.created),
    updated: text(value.updated),
    submitted: textOrNull(value.submitted),
    held: flag(value.held),
    parts: records(value.parts).map(parseBrief),
    partsDelivered: count(value.partsDelivered),
    followUps: records(value.followUps).map(parseBrief),
    run: run
      ? {
          id: text(run.id),
          state: text(run.state),
          stage: text(run.stage),
          candidate: textOrNull(run.candidate),
          configuration: text(run.configuration),
        }
      : null,
    stage: textOrNull(value.stage),
    workers: records(value.workers).map((worker) => ({
      seat: text(worker.seat),
      harness: textOrNull(worker.harness),
      role: textOrNull(worker.role),
      stage: text(worker.stage),
      specialist: textOrNull(worker.specialist),
      since: textOrNull(worker.since),
    })),
    paused: paused
      ? {
          kind: text(paused.kind),
          why: text(paused.why),
          nextTry: textOrNull(paused.nextTry),
          needsPerson: flag(paused.needsPerson),
        }
      : null,
    qa: qa
      ? {
          votes: records(qa.votes).map((vote) => ({
            seat: text(vote.seat),
            provider: text(vote.provider),
            verdict: text(vote.verdict),
          })),
          needed: typeof qa.needed === "number" ? qa.needed : null,
        }
      : null,
    findings: { open: count(findings.open), all: count(findings.all) },
    approvals: records(value.approvals).map((approval) => ({
      actor: text(approval.actor),
      decision: text(approval.decision),
      stands: flag(approval.stands),
    })),
    questions: count(value.questions),
    proposals: count(value.proposals),
    waitsFor: records(value.waitsFor).map(parseBrief),
    messages: count(value.messages),
    unread: count(value.unread),
    unanswered: count(value.unanswered),
    files: count(value.files),
    last: last
      ? {
          at: text(last.at),
          by: text(last.by),
          from: text(last.from),
          kind: text(last.kind),
          text: text(last.text),
        }
      : null,
    blocker: textOrNull(value.blocker),
    waitingOn: textOrNull(value.waitingOn),
    actions: strings(value.actions),
  };
};

export function parseBoard(body: unknown): DeliveryBoard | null {
  if (!isRecord(body) || !Array.isArray(body.lanes)) return null;
  return {
    view: text(body.view),
    views: records(body.views).map((view) => ({ id: text(view.id), title: text(view.title) })),
    teams: strings(body.teams),
    lanes: records(body.lanes).map((lane) => ({
      lane: text(lane.lane),
      title: text(lane.title),
      cards: records(lane.cards).map(parseCard),
    })),
    waiting: count(body.waiting),
    notices: records(body.notices).map((notice) => ({
      key: text(notice.key),
      kind: text(notice.kind),
      text: text(notice.text),
      count: count(notice.count),
    })),
    note: textOrNull(body.note),
  };
}

/** What a search of tasks answers with: cards, newest first. */
export function parseCards(body: unknown): ReadonlyArray<DeliveryCard> {
  return records(body)
    .map(parseCard)
    .filter((card) => card.id.length > 0);
}

export interface CouncilSeat {
  readonly seat: string;
  readonly role: string;
  readonly harness: string;
  readonly provider: string;
  readonly required: boolean;
  readonly requestedModel: string | null;
  readonly actualModel: string | null;
  readonly reasoning: string | null;
  readonly access: string | null;
  readonly activity: string;
  readonly blockedBy: string | null;
  readonly stage: string | null;
  readonly verdict: string | null;
  readonly attempts: number;
}

export interface TaskCouncil {
  readonly run: string;
  readonly state: string;
  readonly stage: string;
  readonly configuration: string;
  readonly candidate: string | null;
  readonly evidence: string | null;
  readonly decision: string | null;
  readonly seats: ReadonlyArray<CouncilSeat>;
  readonly votes: ReadonlyArray<{
    readonly seat: string;
    readonly provider: string;
    readonly verdict: string;
    readonly reason: string;
  }>;
  readonly findings: ReadonlyArray<{
    readonly id: string;
    readonly seat: string;
    readonly title: string;
    readonly blocking: boolean;
    readonly status: string;
  }>;
  readonly concurrency: {
    readonly active: number;
    readonly waiting: number;
    readonly global: number;
  };
}

export interface TaskFile {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly by: string;
  readonly at: string;
  /** The message it was sent with, or null for a file of the task itself. */
  readonly message: number | null;
  /** Where the engine keeps it on its host, which is what a seat is pointed at. */
  readonly path: string;
}

export const parseTaskFile = (value: Json): TaskFile => ({
  id: text(value.id),
  name: text(value.name, "file"),
  type: text(value.type, "application/octet-stream"),
  size: count(value.size),
  by: text(value.by),
  at: text(value.at),
  message: typeof value.message === "number" ? value.message : null,
  path: text(value.path),
});

/** One line of a task's history: something said, or something that happened. */
export interface TimelineEntry {
  readonly id: string;
  readonly at: string;
  readonly source: "message" | "event";
  readonly kind: string;
  readonly by: string;
  /** `person`, `team` or `coordinator` for a message; null for an event. */
  readonly sender: string | null;
  readonly text: string;
  readonly icon: string;
  /** How the engine got somewhere, as opposed to where it got. Hidden unless asked for. */
  readonly detail: boolean;
  /** The message's number, which a reply names. */
  readonly seq: number | null;
  readonly state: string | null;
  readonly replyTo: number | null;
  readonly files: ReadonlyArray<TaskFile>;
  /** For a proposal: the change that was read out of a message. */
  readonly change: string | null;
  readonly revision: number | null;
  readonly run: string | null;
  /** A file of the run's record on the engine's host. */
  readonly evidence: string | null;
}

const parseTimeline = (value: unknown): ReadonlyArray<TimelineEntry> =>
  records(value).map((entry) => {
    const change = entry.change;
    return {
      id: text(entry.id),
      at: text(entry.at),
      source: text(entry.source) === "message" ? "message" : "event",
      kind: text(entry.kind),
      by: text(entry.by),
      sender: textOrNull(entry.sender),
      text: text(entry.text),
      icon: text(entry.icon, "note"),
      detail: flag(entry.detail),
      seq: typeof entry.seq === "number" ? entry.seq : null,
      state: textOrNull(entry.state),
      replyTo: typeof entry.replyTo === "number" ? entry.replyTo : null,
      files: records(entry.files).map(parseTaskFile),
      change:
        typeof change === "string"
          ? change
          : isRecord(change)
            ? text(change.text, JSON.stringify(change))
            : null,
      revision: typeof entry.revision === "number" ? entry.revision : null,
      run: textOrNull(entry.run),
      evidence: textOrNull(entry.evidence),
    };
  });

export interface TaskLink extends TaskBrief {
  readonly kind: string;
  /** `out`: this task names the other. `in`: the other names this one. */
  readonly direction: string;
}

/** A task as its workspace shows it. Board and Orchestrator read the same one. */
export interface TaskView {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly requirements: ReadonlyArray<string>;
  readonly acceptance: ReadonlyArray<string>;
  readonly revision: number;
  readonly state: string;
  readonly lane: string | null;
  readonly team: string;
  readonly priority: TaskPriority;
  readonly priorityBy: string;
  readonly tags: ReadonlyArray<string>;
  readonly owner: string;
  readonly origin: string;
  readonly deadline: string | null;
  readonly created: string;
  readonly updated: string;
  readonly submitted: string | null;
  readonly held: boolean;
  readonly isDraft: boolean;
  readonly parent: TaskBrief | null;
  readonly card: DeliveryCard;
  readonly actions: ReadonlyArray<string>;
  readonly timeline: ReadonlyArray<TimelineEntry>;
  readonly questions: ReadonlyArray<{
    readonly seq: number;
    readonly at: string;
    readonly by: string;
    readonly text: string;
  }>;
  readonly proposals: ReadonlyArray<{
    readonly seq: number;
    readonly at: string;
    readonly by: string;
    readonly text: string;
    readonly change: string;
  }>;
  readonly files: ReadonlyArray<TaskFile>;
  readonly links: ReadonlyArray<TaskLink>;
  readonly followUps: ReadonlyArray<TaskBrief>;
  readonly revisions: ReadonlyArray<{
    readonly revision: number;
    readonly notes: string | null;
    readonly created: string;
    readonly body: string;
  }>;
  readonly workflow: string;
  readonly workflows: ReadonlyArray<DeliveryWorkflow>;
  readonly configuration: string;
  /** The revision of the team's defaults the settings are laid over. */
  readonly defaults: number;
  readonly roster: ReadonlyArray<DeliverySeat>;
  readonly settings: ReadonlyArray<SeatSettings>;
  readonly settingsProblems: ReadonlyArray<string>;
  /** Whether the engine is moving the task on at this moment. */
  readonly working: boolean;
  readonly parts: ReadonlyArray<{
    readonly id: string;
    readonly number: number;
    readonly title: string;
    readonly state: string;
  }>;
  readonly children: ReadonlyArray<{
    readonly run: string;
    readonly state: string;
    readonly stage: string;
    readonly whole: boolean;
  }>;
  readonly council: TaskCouncil | null;
  readonly pendingFromPerson: number;
}

const parseCouncil = (council: Json): TaskCouncil => {
  const concurrency = isRecord(council.concurrency) ? council.concurrency : {};
  return {
    run: text(council.run),
    state: text(council.state),
    stage: text(council.stage),
    configuration: text(council.configuration),
    candidate: textOrNull(council.candidate),
    evidence: textOrNull(council.evidence),
    decision: textOrNull(council.decision),
    seats: records(council.seats).map((seat) => ({
      seat: text(seat.seat),
      role: text(seat.role),
      harness: text(seat.harness),
      provider: text(seat.provider),
      required: flag(seat.required),
      requestedModel: textOrNull(seat.requestedModel),
      actualModel: textOrNull(seat.actualModel),
      reasoning: textOrNull(seat.reasoning),
      access: textOrNull(seat.access),
      activity: text(seat.activity, "waiting"),
      blockedBy: textOrNull(seat.blockedBy),
      stage: textOrNull(seat.stage),
      verdict: textOrNull(seat.verdict),
      attempts: list(seat.attempts).length,
    })),
    votes: records(council.votes).map((vote) => ({
      seat: text(vote.seat),
      provider: text(vote.provider),
      verdict: text(vote.verdict),
      reason: text(vote.reason),
    })),
    findings: records(council.findings).map((finding) => ({
      id: text(finding.id),
      seat: text(finding.seat),
      title: text(finding.title),
      blocking: flag(finding.blocking),
      status: text(finding.status),
    })),
    concurrency: {
      active: count(concurrency.active),
      waiting: count(concurrency.waiting),
      global: count(concurrency.global),
    },
  };
};

export function parseTask(body: unknown): TaskView | null {
  if (!isRecord(body) || !isRecord(body.card) || text(body.id).length === 0) return null;
  const parent = isRecord(body.parent) ? body.parent : null;
  const council = isRecord(body.council) ? body.council : null;
  const state = text(body.state);
  return {
    id: text(body.id),
    number: count(body.number),
    title: text(body.title),
    body: text(body.body),
    requirements: strings(body.requirements),
    acceptance: strings(body.acceptance),
    revision: count(body.revision),
    state,
    lane: textOrNull(body.lane),
    team: text(body.team),
    priority: priorityOf(body.priority),
    priorityBy: text(body.priorityBy, "default"),
    tags: strings(body.tags),
    owner: text(body.owner),
    origin: text(body.origin),
    deadline: textOrNull(body.deadline),
    created: text(body.created),
    updated: text(body.updated),
    submitted: textOrNull(body.submitted),
    held: flag(body.held),
    isDraft: state === "draft",
    parent: parent ? parseBrief(parent) : null,
    card: parseCard(body.card),
    actions: strings(body.actions),
    timeline: parseTimeline(body.timeline),
    questions: records(body.questions).map((question) => ({
      seq: count(question.seq),
      at: text(question.at),
      by: text(question.by),
      text: text(question.text),
    })),
    proposals: records(body.proposals).map((proposal) => ({
      seq: count(proposal.seq),
      at: text(proposal.at),
      by: text(proposal.by),
      text: text(proposal.text),
      change:
        typeof proposal.change === "string"
          ? proposal.change
          : isRecord(proposal.change)
            ? text(proposal.change.text, JSON.stringify(proposal.change))
            : "",
    })),
    files: records(body.files).map(parseTaskFile),
    links: records(body.links).map((link) => ({
      ...parseBrief(link),
      kind: text(link.kind, "related"),
      direction: text(link.direction, "out"),
    })),
    followUps: records(body.followUps).map(parseBrief),
    revisions: records(body.revisions).map((revision) => ({
      revision: count(revision.revision),
      notes: textOrNull(revision.notes),
      created: text(revision.created),
      body: text(revision.body),
    })),
    workflow: text(body.workflow, "standard"),
    workflows: parseWorkflows(body.workflows),
    configuration: text(body.configuration),
    defaults: count(body.defaults),
    roster: records(body.roster).map(parseSeat),
    settings: records(body.settings).map(parseSeatSettings),
    settingsProblems: strings(body.settingsProblems),
    working: flag(body.working),
    parts: records(body.parts).map((part) => ({
      id: text(part.id),
      number: count(part.number),
      title: text(part.title),
      state: text(part.state),
    })),
    children: records(body.children).map((child) => ({
      run: text(child.run),
      state: text(child.state),
      stage: text(child.stage),
      whole: flag(child.whole),
    })),
    council: council ? parseCouncil(council) : null,
    pendingFromPerson: count(body.pendingFromPerson),
  };
}

/** What the engine lists when it refuses, e.g. each seat setting that cannot be used. */
export function deliveryFailureProblems(error: unknown): ReadonlyArray<string> {
  if (!isRecord(error) || !isRecord(error.body)) return [];
  return strings(error.body.problems);
}

/** The engine's own reason when it refused, read from the relayed error. */
export function deliveryFailureText(error: unknown): string {
  if (isRecord(error) && text(error._tag) === "DeliveryError") {
    const reason = text(error.reason);
    const detail = text(error.detail, "The delivery engine refused the request.");
    if (reason === "unreachable") return `Delivery engine not reachable. ${detail}`;
    if (reason === "disabled") return "Delivery is turned off in settings.";
    return detail;
  }
  if (error instanceof Error && error.message) return error.message;
  return "The request to the delivery engine failed.";
}

/** A reading older than this is shown as stale, so a quiet board is not taken for a live one. */
export const DELIVERY_STALE_AFTER_MS = 20_000;

export function isStaleReading(readAt: string | null, nowMs: number): boolean {
  if (!readAt) return true;
  const at = Date.parse(readAt);
  return Number.isNaN(at) || nowMs - at > DELIVERY_STALE_AFTER_MS;
}

export const draftTeamKey = (threadId: ThreadId | string) => String(threadId);

export type TeamSendDecision =
  /** Nothing to set up: delivery is off, the thread is bound, or it never had a team. */
  | { readonly action: "none" }
  | { readonly action: "bind"; readonly team: string; readonly role: string }
  /** The person chose "No team" for a thread whose team setup had failed. */
  | { readonly action: "release" }
  | { readonly action: "blocked"; readonly why: string };

/**
 * What has to happen to a thread's team before a turn may start. A team
 * choice stays in force until a turn has really started with it, so a send
 * that failed half way is followed by the same setup and never by an
 * ordinary thread.
 */
export function decideTeamForSend(input: {
  readonly enabled: boolean;
  readonly isServerThread: boolean;
  readonly bound: boolean;
  readonly held: { readonly team: string; readonly role: string | null } | null;
  /** Set when the server could not say whether the thread belongs to a team. */
  readonly stateError: string | null;
  readonly draft: { readonly team: string | null; readonly role: string | null };
  /** Whether the person has made a choice for this thread since it was held. */
  readonly draftIsExplicit: boolean;
  readonly teams: ReadonlyArray<DeliveryTeam>;
  readonly teamsError: string | null;
  readonly driver: string | null;
}): TeamSendDecision {
  if (!input.enabled) return { action: "none" };
  if (input.stateError) {
    return {
      action: "blocked",
      why: `Whether this thread belongs to a team could not be read, so it is not started. ${input.stateError}`,
    };
  }
  if (input.bound) return { action: "none" };
  if (input.isServerThread && !input.held) return { action: "none" };

  // A held thread is retried with the team it was held for, unless the person chose again.
  const choice =
    input.held && !input.draftIsExplicit
      ? { team: input.held.team, role: input.held.role }
      : input.draft;
  if (choice.team === null) return input.held ? { action: "release" } : { action: "none" };
  if (input.teamsError) {
    return {
      action: "blocked",
      why: `Delivery engine not reachable, so team ${choice.team} cannot be loaded. Choose "No team" to start an ordinary thread.`,
    };
  }
  const resolved = resolveTeamChoice({
    teams: input.teams,
    team: choice.team,
    role: choice.role,
    driver: input.driver,
  });
  if (resolved.state === "blocked") return { action: "blocked", why: resolved.why };
  if (resolved.state === "choose-role") {
    return {
      action: "blocked",
      why: `Choose a role in team ${resolved.team}: ${resolved.roles.join(", ")}.`,
    };
  }
  if (resolved.state === "manual") return { action: "none" };
  return { action: "bind", team: resolved.team, role: resolved.role };
}
