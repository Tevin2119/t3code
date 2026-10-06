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
  /** `built-in` for a team that comes with the engine, `custom` for a profile a person made. */
  readonly source: string;
  readonly purpose: string;
  readonly configuration: string;
  readonly available: boolean;
  readonly why: string | null;
  readonly flows: ReadonlyArray<DeliveryFlow>;
  readonly defaultFlow: string;
  /**
   * Whether a task can be given to the team. A team without a flow of stages
   * works in sessions a person opens, and takes no task.
   */
  readonly takesTasks: boolean;
  readonly whyNoTasks: string | null;
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
  readonly summary: string;
  readonly stages: ReadonlyArray<string>;
  readonly stop: string;
  /** Whether the flow changes files. A chat, a plan and a review do not. */
  readonly builds: boolean;
}

/** A flow of a team, with whether it can run with the seats as they are set. */
export interface DeliveryFlow extends DeliveryWorkflow {
  /** Whether the team has the seats for it at all. */
  readonly offered: boolean;
  readonly why: string | null;
  readonly ready: boolean;
  /** What the flow lacks, in the engine's words: which seat to switch on, and why. */
  readonly problems: ReadonlyArray<string>;
  /** The seats that would take part. */
  readonly seats: ReadonlyArray<string>;
  readonly isDefault: boolean;
}

export const FLOW_START_LABEL: Readonly<Record<string, string>> = {
  chat: "Start team chat",
  plan: "Start plan",
  review: "Start review",
  standard: "Start delivery",
};

export const flowStartLabel = (flow: string | null | undefined) =>
  FLOW_START_LABEL[flow ?? ""] ?? "Start workflow";

export const parseFlows = (value: unknown): ReadonlyArray<DeliveryFlow> =>
  records(value)
    .filter((item) => text(item.id).length > 0)
    .map((item) => ({
      id: text(item.id),
      title: text(item.title, text(item.id)),
      summary: text(item.summary),
      stages: strings(item.stages),
      stop: text(item.stop),
      builds: flag(item.builds),
      offered: item.offered !== false,
      why: textOrNull(item.why),
      ready: item.ready !== false,
      problems: strings(item.problems),
      seats: strings(item.seats),
      isDefault: flag(item.isDefault),
    }));

export const SEAT_SETTING_KEYS = ["active", "harness", "model", "reasoning", "access"] as const;
export type SeatSettingKey = (typeof SEAT_SETTING_KEYS)[number];
/** What a person chose for a seat. A key left out runs as the team has it. */
export type SeatChoice = Partial<Record<SeatSettingKey, string>>;

export interface SeatSettingValues {
  /** `on` or `off`. A seat that is off keeps what is set for it and takes no new work. */
  readonly active: string | null;
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
  /** What the seat does in its team: leads, plans, builds, reviews, tests. */
  readonly duties: ReadonlyArray<string>;
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
  /** Which layer gave each value of `now`: the team definition, the team defaults, or a board. */
  readonly source: Readonly<Partial<Record<SeatSettingKey | "fallbacks", string>>>;
  /** The fallbacks set for the seat by the layers, empty when none are set. */
  readonly fallbacks: ReadonlyArray<SeatFallback>;
  /** Who will actually take the seat's place, in order: what is set, else the team's own pair. */
  readonly fallbackChain: ReadonlyArray<SeatFallback>;
  /** What the team's definition alone would use. */
  readonly definedFallbackChain: ReadonlyArray<SeatFallback>;
  readonly fallbacksAllowed: boolean;
  /** The fallbacks the saved defaults name, or null when they name none. */
  readonly savedFallbacks: ReadonlyArray<SeatFallback> | null;
  /** What a board sets for this seat, when read for a board. */
  readonly board: SeatChoice;
  readonly boardFallbacks: ReadonlyArray<SeatFallback> | null;
}

/** A harness, with a model where it takes one, that stands in for a seat. */
export interface SeatFallback {
  readonly harness: string;
  readonly model: string | null;
}

/** At most this many fallbacks for one seat; the engine holds the same limit. */
export const MOST_FALLBACKS = 3;

const parseFallbacks = (value: unknown): ReadonlyArray<SeatFallback> =>
  records(value)
    .filter((item) => text(item.harness).length > 0)
    .map((item) => ({ harness: text(item.harness), model: textOrNull(item.model) }));

const fallbacksOrNull = (value: unknown): ReadonlyArray<SeatFallback> | null =>
  isRecord(value) && Array.isArray(value.fallbacks) ? parseFallbacks(value.fallbacks) : null;

const parseValues = (value: unknown, harness: string | null = null): SeatSettingValues => {
  const from = isRecord(value) ? value : {};
  return {
    active: textOrNull(from.active),
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
    duties: strings(value.duties),
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
    source: Object.fromEntries(
      Object.entries(isRecord(value.source) ? value.source : {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    fallbacks: parseFallbacks(value.fallbacks),
    fallbackChain: parseFallbacks(value.fallbackChain ?? value.fallbacks),
    // An engine that does not say what the definition alone would use: the chain in use stands in.
    definedFallbackChain: parseFallbacks(
      value.definedFallbackChain ?? value.fallbackChain ?? value.fallbacks,
    ),
    fallbacksAllowed: flag(value.fallbacksAllowed),
    savedFallbacks: fallbacksOrNull(value.saved),
    board: parseChoice(value.board),
    boardFallbacks: fallbacksOrNull(value.board),
  };
};

/**
 * The layers that set what a seat runs on, other than the team's definition,
 * in words: "team defaults r3", "board Pilot". Empty when it runs as defined.
 */
export function seatSources(item: SeatSettings): ReadonlyArray<string> {
  return [
    ...new Set(
      Object.values(item.source).filter(
        (source): source is string => Boolean(source) && source !== "team definition",
      ),
    ),
  ];
}

/**
 * The fallbacks to send for one seat, or null when they are left as they are. An empty list is
 * sent: it says "none", where leaving them out inherits.
 */
export function fallbacksToSend(
  wanted: ReadonlyArray<SeatFallback> | null | undefined,
): ReadonlyArray<{ harness: string; model?: string }> | null {
  if (!wanted) return null;
  return wanted
    .filter((item) => item.harness)
    .map((item) =>
      item.model ? { harness: item.harness, model: item.model } : { harness: item.harness },
    );
}

/** Seat settings with each seat's fallbacks added where they are named. */
export function withFallbacks(
  seats: Record<string, Record<string, unknown>>,
  fallbacks: Readonly<Record<string, ReadonlyArray<SeatFallback> | null>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = { ...seats };
  for (const [seat, wanted] of Object.entries(fallbacks)) {
    const sent = fallbacksToSend(wanted);
    if (sent) out[seat] = { ...out[seat], fallbacks: sent };
  }
  return out;
}

/** What a board sets for the seats of each team. */
export interface BoardSeats {
  readonly team: string;
  /** The revision of the board's seats this reading is of; a save names it. */
  readonly revision: number;
  readonly settings: ReadonlyArray<SeatSettings>;
}

export function parseBoardSeats(body: unknown): ReadonlyArray<BoardSeats> {
  const rows = isRecord(body) && Array.isArray(body.teams) ? body.teams : body;
  return records(rows)
    .filter((row) => text(row.team).length > 0)
    .map((row) => ({
      team: text(row.team),
      revision: count(row.revision),
      settings: records(row.seats).map(parseSeatSettings),
    }));
}

/** How one harness and model has done in one stage of one team, on this host. */
export interface TrackRecordRow {
  readonly team: string;
  readonly stage: string;
  readonly harness: string;
  readonly model: string | null;
  readonly attempts: number;
  readonly answered: number;
  readonly answeredShare: number | null;
  readonly medianSeconds: number | null;
  readonly lastAt: string | null;
  /** Why it did not answer, by kind: rate-limit, sign-in, timeout and the like. */
  readonly notAnswered: Readonly<Record<string, number>>;
  /** What triage decided, by bucket. */
  readonly decisions: Readonly<Record<string, number>>;
  /** What QA concluded, by verdict. */
  readonly verdicts: Readonly<Record<string, number>>;
  /** How often it took a seat's place after the seat could not answer. */
  readonly steppedIn: number;
}

const tally = (value: unknown): Record<string, number> =>
  Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0,
    ),
  );

export function parseTrackRecord(body: unknown): ReadonlyArray<TrackRecordRow> {
  return records(isRecord(body) ? body.rows : null).map((row) => ({
    team: text(row.team),
    stage: text(row.stage),
    harness: text(row.harness, "unknown"),
    model: textOrNull(row.model),
    attempts: count(row.attempts),
    answered: count(row.answered),
    answeredShare: typeof row.answeredShare === "number" ? row.answeredShare : null,
    medianSeconds: typeof row.medianSeconds === "number" ? row.medianSeconds : null,
    lastAt: textOrNull(row.lastAt),
    notAnswered: tally(row.notAnswered),
    decisions: tally(row.decisions),
    verdicts: tally(row.verdicts),
    steppedIn: count(row.steppedIn),
  }));
}

/** Whether a seat is on, with what is chosen for it laid over what it is set to. */
export const seatIsOn = (item: SeatSettings, choice: SeatChoice, over: "now" | "defined" = "now") =>
  (choice.active ?? item[over].active ?? "on") !== "off";

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
  if (choice.active) next.active = choice.active;
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
    summary: text(item.summary),
    stages: strings(item.stages),
    stop: text(item.stop),
    builds: item.builds !== false,
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
  const flows = parseFlows(team.flows);
  return {
    team: text(team.team),
    source: text(team.source, "built-in"),
    purpose: text(team.purpose),
    configuration: text(team.configuration),
    flows,
    defaultFlow: text(team.defaultFlow, flows.find((flow) => flow.isDefault)?.id ?? "standard"),
    available: flag(team.available),
    why: textOrNull(team.why),
    // An engine that does not say is one from before teams were told apart this way.
    takesTasks: team.takesTasks !== false,
    whyNoTasks: textOrNull(team.whyNoTasks),
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
      // Whether a seat is on has nothing to do with what it runs on.
      if (key === "active") return value !== (base.active ?? "on") ? [[key, value]] : [];
      return moved || value !== (base[key] ?? "") ? [[key, value]] : [];
    });
    if (kept.length > 0) out[item.seat] = Object.fromEntries(kept);
  }
  return out;
}

/**
 * Why work cannot be given to a team now, or null when it can. With a flow
 * named, it is that flow that is asked about. Without one, a team that has
 * any flow can be given work.
 */
export function teamTaskBlock(team: DeliveryTeam, flow: string | null = null): string | null {
  if (team.flows.length === 0) {
    // An engine from before flows: a team delivers, or it takes no task.
    if (!team.takesTasks) {
      return team.whyNoTasks ?? "This team works in sessions and takes no task.";
    }
  } else if (flow) {
    const wanted = team.flows.find((item) => item.id === flow);
    if (!wanted || !wanted.offered) {
      const has = team.flows.filter((item) => item.offered).map((item) => item.title);
      return `Team ${team.team} has no ${wanted?.title.toLowerCase() ?? flow}. It has: ${has.join(", ") || "no flow"}.`;
    }
  } else if (!team.flows.some((item) => item.offered)) {
    return `Team ${team.team} has no flow it could run.`;
  }
  return team.available ? null : (team.why ?? "This team cannot work now.");
}

/** The flow a team runs when none is chosen, or the first it has. */
export function flowFor(team: DeliveryTeam | null, wanted: string | null): string {
  if (!team) return wanted ?? "standard";
  const offered = team.flows.filter((flow) => flow.offered);
  if (wanted && offered.some((flow) => flow.id === wanted)) return wanted;
  return offered.find((flow) => flow.id === team.defaultFlow)?.id ?? offered[0]?.id ?? "standard";
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
  /** Why it has not started yet, when the engine holds it (for memory, or a free slot); null at work. */
  readonly waiting: string | null;
  /** The same, in words a person can act on: who holds the slots, or the memory it waits for. */
  readonly waitingWhy: string | null;
}

/** The seats at work on a card, as opposed to those the engine holds before they start. */
export const seatsAtWork = (card: Pick<DeliveryCard, "workers">) =>
  card.workers.filter((worker) => !worker.waiting);

/**
 * The card's "now" in a few words: working on a stage while any seat works, waiting (and for
 * what, when every held seat waits for the same) while every seat is held.
 */
export function nowLine(card: Pick<DeliveryCard, "workers" | "stage">): string | null {
  if (card.workers.length === 0) return null;
  const stage = card.stage || card.workers[0]!.stage;
  const on = stage ? `: ${stage}` : "";
  if (seatsAtWork(card).length > 0) return `Working${on}`;
  const reasons = [...new Set(card.workers.map((worker) => waitingWords(worker.waiting)))];
  return reasons.length === 1
    ? `${reasons[0]![0]!.toUpperCase()}${reasons[0]!.slice(1)}${on}`
    : `Waiting${on}`;
}

/** Who is on a card, each seat said once: those working, then each held seat with its own reason. */
export function crewLine(card: Pick<DeliveryCard, "workers">): string {
  const working = seatsAtWork(card).map((worker) => worker.seat);
  const held = card.workers
    .filter((worker) => worker.waiting)
    .map((worker) => `${worker.seat} ${waitingWords(worker.waiting)}`);
  return [working.length ? `${working.join(", ")} working` : null, ...held]
    .filter(Boolean)
    .join("; ");
}

/**
 * Where a settings form stands with a reading. A draft is what the person changed, kept with the
 * revision it was made against (`base`) for as long as it is kept. It gives way to a reading only
 * when it is still what the form's own save answered and the reading is at least that save: then
 * nothing of the person's is lost. A draft made against an older revision than the reading's is
 * behind: saving it would be refused, and the form says so rather than saving over a reading the
 * person has not seen.
 */
export function draftAgainstRead(input: {
  /** The revision the draft was made against; null when there is no draft. */
  readonly base: number | null;
  readonly readRevision: number;
  /** The draft is still exactly what the form's own last save answered. */
  readonly asSaved: boolean;
}): "none" | "take-read" | "keep" | "behind" {
  if (input.base === null) return "none";
  if (input.asSaved && input.readRevision >= input.base) return "take-read";
  return input.readRevision > input.base ? "behind" : "keep";
}

/** What a held seat waits for, in words. */
export const waitingWords = (reason: string | null): string =>
  reason === "memory headroom" || reason === "host under memory pressure"
    ? "waits for memory"
    : reason === "global limit"
      ? "waits for a free slot"
      : reason
        ? `waits for ${reason}`
        : "is working";

export interface DeliveryCard {
  readonly id: string;
  /** The number a person says and searches by, e.g. 1001. */
  readonly number: number;
  readonly title: string;
  readonly team: string;
  /** The flow it was given in: a chat, a plan, a review or a delivery. */
  readonly flow: string;
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
  /** For a card a person paused: the column it goes on in when resumed. */
  readonly resumesIn: string | null;
  /** In Paused because the engine holds it after a failure, not because a person paused it. */
  readonly recovering: boolean;
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
    /** As last proved for display, at `verifiedAt`. Approving and publishing prove it again. */
    readonly stands: boolean;
    readonly verifiedAt: string | null;
  }>;
  /** Questions of the team that wait for a person. */
  readonly questions: number;
  readonly proposals: number;
  readonly waitsFor: ReadonlyArray<TaskBrief>;
  /** For a part of a split task: the task it is a part of. Its decision is made there. */
  readonly partOf: { readonly id: string; readonly number: number; readonly title: string } | null;
  /** For a part: who reviewed it as it stands. A review of a part does not approve the whole. */
  readonly reviewedBy: string | null;
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
  /** "qualification" for a task of the engine's qualification, kept apart from the pilot's work. */
  readonly set: string | null;
  /** What became of the approved change: pushed, a pull request, merged, or a failed attempt. */
  readonly publication: DeliveryPublication | null;
  readonly actions: ReadonlyArray<string>;
  /** Put first by a person for the next free slots (Do next). */
  readonly first: boolean;
}

/**
 * The approved commit put up for review. Approval is a record; this is what happened after it.
 * `state`: pushing, pushed, pr-open, merged, closed or failed.
 */
export interface DeliveryPublication {
  readonly run: string | null;
  readonly state: string;
  readonly branch: string;
  readonly commit: string;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  readonly error: string | null;
  readonly attempts: number;
}

const parsePublication = (value: unknown): DeliveryPublication | null => {
  if (!isRecord(value)) return null;
  const pull = isRecord(value.pullRequest) ? value.pullRequest : null;
  return {
    run: textOrNull(value.run),
    state: text(value.state),
    branch: text(value.branch),
    commit: text(value.commit),
    pullRequest: pull ? { number: count(pull.number), url: text(pull.url) } : null,
    error: textOrNull(value.error),
    attempts: count(value.attempts),
  };
};

export interface DeliveryLane {
  readonly lane: string;
  readonly title: string;
  readonly cards: ReadonlyArray<DeliveryCard>;
}

export interface DeliveryBoard {
  readonly view: string;
  /** The four views that come with the engine, then a person's own ("own"), with their columns. */
  readonly views: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly kind: string;
    readonly lanes: ReadonlyArray<string> | null;
  }>;
  readonly teams: ReadonlyArray<string>;
  readonly lanes: ReadonlyArray<DeliveryLane>;
  /** Which tasks the board shows, and how many each choice holds. */
  readonly set: string;
  readonly sets: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description: string;
    /** "own" for a board a person made, "kept" for the qualification, "built-in" otherwise. */
    readonly kind: string;
    readonly count: number;
    /** The repository and base branch its tasks are done in; null for a board that holds none. */
    readonly target: DeliveryTarget | null;
  }>;
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
    flow: text(value.flow, "standard"),
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
    resumesIn: textOrNull(value.resumesIn),
    recovering: flag(value.recovering),
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
      waiting: textOrNull(worker.waiting),
      waitingWhy: textOrNull(worker.waitingWhy),
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
      verifiedAt: textOrNull(approval.verifiedAt),
    })),
    questions: count(value.questions),
    proposals: count(value.proposals),
    waitsFor: records(value.waitsFor).map(parseBrief),
    partOf: isRecord(value.partOf)
      ? {
          id: text(value.partOf.id),
          number: count(value.partOf.number),
          title: text(value.partOf.title),
        }
      : null,
    reviewedBy: typeof value.reviewedBy === "string" && value.reviewedBy ? value.reviewedBy : null,
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
    set: textOrNull(value.set),
    publication: parsePublication(value.publication),
    actions: strings(value.actions),
    first: flag(value.first),
  };
};

export function parseBoard(body: unknown): DeliveryBoard | null {
  if (!isRecord(body) || !Array.isArray(body.lanes)) return null;
  return {
    view: text(body.view),
    views: records(body.views).map((view) => ({
      id: text(view.id),
      title: text(view.title),
      description: text(view.description),
      kind: text(view.kind, "built-in"),
      lanes: Array.isArray(view.lanes) ? strings(view.lanes) : null,
    })),
    teams: strings(body.teams),
    set: text(body.set) || "pilot",
    sets: records(body.sets).map((item) => ({
      id: text(item.id),
      title: text(item.title, text(item.id)),
      description: text(item.description),
      kind: text(item.kind, "built-in"),
      count: count(item.count),
      target: parseTarget(item.target),
    })),
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
  /** Why it waits, in words a person can act on. */
  readonly waitingWhy: string | null;
  readonly stage: string | null;
  readonly verdict: string | null;
  readonly attempts: number;
  /** What it is doing now, from its own output, while it works; null otherwise. */
  readonly live: SeatLive | null;
}

/** What a seat at work last did: the tools it called and what it said, newest last. */
export interface SeatLive {
  readonly started: string | null;
  readonly updated: string | null;
  readonly items: ReadonlyArray<{ readonly kind: "tool" | "said" | "log"; readonly text: string }>;
}

/** An instruction a person gave a run while it was under way. */
export interface RunSteer {
  readonly at: string;
  readonly by: string;
  readonly seat: string | null;
  readonly text: string;
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
  /** What the run wrote for a person to read: PLAN.md, REVIEW.md, PACK.md. */
  readonly documents: ReadonlyArray<string>;
  readonly steers: ReadonlyArray<RunSteer>;
  /** Whether a person put the task first for the next free slots. */
  readonly first: boolean;
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

/**
 * What is needed of a person, in plain words, when a task waits on one: the bottom line first,
 * then what the task is, what happened, why it stopped, each choice, where and since when.
 */
export interface TaskBriefing {
  readonly headline: string;
  readonly what: string;
  readonly happened: ReadonlyArray<string>;
  readonly why: string | null;
  readonly options: ReadonlyArray<{
    readonly action: string;
    readonly label: string;
    readonly does: string;
    readonly recommended: boolean;
  }>;
  readonly reply: string | null;
  readonly where: string | null;
  readonly since: string | null;
}

/**
 * A key for each value: which repeat of it this is, then the value. The count leads up to the
 * first colon, so no two values give the same key.
 */
export function repeatKeys(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Map<string, number>();
  return values.map((value) => {
    const count = (seen.get(value) ?? 0) + 1;
    seen.set(value, count);
    return `${count}:${value}`;
  });
}

export function parseBriefing(value: unknown): TaskBriefing | null {
  if (!isRecord(value) || text(value.headline).length === 0) return null;
  return {
    headline: text(value.headline),
    what: text(value.what),
    happened: strings(value.happened),
    why: textOrNull(value.why),
    options: records(value.options).map((option) => ({
      action: text(option.action),
      label: text(option.label, text(option.action)),
      does: text(option.does),
      recommended: flag(option.recommended),
    })),
    reply: textOrNull(value.reply),
    where: textOrNull(value.where),
    since: textOrNull(value.since),
  };
}

/** A task as its workspace shows it. Board and Orchestrator read the same one. */
export interface TaskView {
  /** Null unless the task waits on a person. */
  readonly brief: TaskBriefing | null;
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
  readonly flows: ReadonlyArray<DeliveryFlow>;
  /** The seats that are switched on for this work. */
  readonly seatsOn: ReadonlyArray<string>;
  /** The plan, once a plan was settled. It is agreed when the delivery was started from it. */
  readonly plan: {
    readonly run: string;
    readonly agreed: boolean;
    readonly approach: string;
    readonly steps: ReadonlyArray<string>;
    readonly checks: ReadonlyArray<string>;
    readonly limits: ReadonlyArray<string>;
    readonly comments: ReadonlyArray<{
      readonly seat: string;
      readonly stance: string;
      readonly points: ReadonlyArray<string>;
    }>;
    readonly file: string;
  } | null;
  /** What a review found, seat by seat. */
  readonly review: {
    readonly run: string;
    readonly examined: string;
    readonly missing: ReadonlyArray<string>;
    readonly file: string;
    readonly seats: ReadonlyArray<{
      readonly seat: string;
      readonly harness: string;
      readonly summary: string;
      readonly checked: ReadonlyArray<string>;
      readonly findings: ReadonlyArray<{
        readonly title: string;
        readonly where: string;
        readonly detail: string;
        readonly blocking: boolean;
      }>;
    }>;
  } | null;
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
  /** Every publication of this task's approved runs, oldest first. */
  readonly publications: ReadonlyArray<DeliveryPublication>;
  /** Whether this engine publishes, and what stands in the way for this task now. */
  readonly publishing: {
    readonly enabled: boolean;
    readonly why: string | null;
    readonly host: string | null;
    readonly base: string | null;
    readonly run: string | null;
    readonly blockers: ReadonlyArray<string>;
  };
  /** Where its work is done. */
  readonly target: DeliveryTarget | null;
  /** The conversation this task was made from: `<environment>/<thread>`. */
  readonly source: {
    readonly kind: "thread";
    readonly environmentId: string;
    readonly threadId: string;
  } | null;
}

export function parseSeatLive(value: unknown): SeatLive | null {
  if (!isRecord(value)) return null;
  return {
    started: textOrNull(value.started),
    updated: textOrNull(value.updated),
    // The engine sends a few short lines; a larger reading is cut to the same.
    items: records(value.items)
      .flatMap((item): Array<SeatLive["items"][number]> => {
        const kind = text(item.kind);
        return kind === "tool" || kind === "said" || kind === "log"
          ? [{ kind, text: text(item.text).slice(0, 300) }]
          : [];
      })
      .slice(-8),
  };
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
      waitingWhy: textOrNull(seat.waitingWhy),
      stage: textOrNull(seat.stage),
      verdict: textOrNull(seat.verdict),
      attempts: list(seat.attempts).length,
      live: parseSeatLive(seat.live),
    })),
    documents: [...new Set(strings(council.documents))],
    steers: records(council.steers).map((steer) => ({
      at: text(steer.at),
      by: text(steer.by),
      seat: textOrNull(steer.seat),
      text: text(steer.text),
    })),
    first: flag(council.first),
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
    brief: parseBriefing(body.brief),
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
    flows: parseFlows(body.flows),
    seatsOn: strings(body.seatsOn),
    plan: isRecord(body.plan)
      ? {
          run: text(body.plan.run),
          agreed: flag(body.plan.agreed),
          approach: text(body.plan.approach),
          steps: strings(body.plan.steps),
          checks: strings(body.plan.checks),
          limits: strings(body.plan.limits),
          comments: records(body.plan.comments).map((comment) => ({
            seat: text(comment.seat),
            stance: text(comment.stance),
            points: strings(comment.points),
          })),
          file: text(body.plan.file),
        }
      : null,
    review: isRecord(body.review)
      ? {
          run: text(body.review.run),
          examined: text(body.review.examined),
          missing: strings(body.review.missing),
          file: text(body.review.file),
          seats: records(body.review.seats).map((seat) => ({
            seat: text(seat.seat),
            harness: text(seat.harness),
            summary: text(seat.summary),
            checked: strings(seat.checked),
            findings: records(seat.findings).map((finding) => ({
              title: text(finding.title),
              where: text(finding.where),
              detail: text(finding.detail),
              blocking: flag(finding.blocking),
            })),
          })),
        }
      : null,
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
    publications: records(body.publications).flatMap((item) => parsePublication(item) ?? []),
    publishing: (() => {
      const publishing = isRecord(body.publishing) ? body.publishing : {};
      return {
        enabled: publishing.enabled === true,
        why: textOrNull(publishing.why),
        host: textOrNull(publishing.host),
        base: textOrNull(publishing.base),
        run: textOrNull(publishing.run),
        blockers: strings(publishing.blockers),
      };
    })(),
    target: parseTarget(body.target),
    source: (() => {
      const source = isRecord(body.source) ? body.source : null;
      const ref = source ? text(source.ref) : "";
      const slash = ref.indexOf("/");
      return source?.kind === "thread" && slash > 0
        ? {
            kind: "thread" as const,
            environmentId: ref.slice(0, slash),
            threadId: ref.slice(slash + 1),
          }
        : null;
    })(),
  };
}

/** Where a task's work is done: a repository, the branch it starts from, and whether it can be. */
export interface DeliveryTarget {
  readonly repository: string | null;
  readonly base: string | null;
  readonly title: string | null;
  readonly path: string | null;
  readonly ok: boolean;
  readonly problem: string | null;
}

export function parseTarget(value: unknown): DeliveryTarget | null {
  if (!isRecord(value)) return null;
  return {
    repository: textOrNull(value.repository),
    base: textOrNull(value.base),
    title: textOrNull(value.title),
    path: textOrNull(value.path),
    ok: value.ok === true,
    problem: textOrNull(value.problem),
  };
}

/** A target in one line: "PolyMania · main", or why work cannot be done there. */
export function targetLine(target: DeliveryTarget | null): string {
  if (!target?.repository) return "Repository not configured";
  const name = target.title ?? target.repository;
  if (!target.ok) return `${name}: ${target.problem ?? "cannot be worked on"}`;
  return `${name} · ${target.base ?? "its checkout as it stands"}`;
}

/** A repository a board can be bound to, with its branches. */
export interface DeliveryRepository {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly defaultBase: string | null;
  readonly branches: ReadonlyArray<string>;
  readonly kind: string;
  readonly ok: boolean;
  readonly problem: string | null;
}

export function parseRepositories(body: unknown): ReadonlyArray<DeliveryRepository> {
  return (Array.isArray(body) ? body : []).flatMap((item: unknown) =>
    isRecord(item) && typeof item.id === "string"
      ? [
          {
            id: item.id,
            title: text(item.title, item.id),
            path: text(item.path),
            defaultBase: textOrNull(item.defaultBase),
            branches: strings(item.branches),
            kind: text(item.kind, "own"),
            ok: item.ok === true,
            problem: textOrNull(item.problem),
          },
        ]
      : [],
  );
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

export interface ProfileSummary {
  readonly profile: string;
  readonly source: string;
  readonly editable: boolean;
  readonly purpose: string;
  readonly revision: number;
  readonly configuration: string | null;
  readonly seats: number;
  readonly seatsOn: number;
  readonly flows: ReadonlyArray<string>;
  readonly defaultFlow: string | null;
  /** Where its files are on the engine's host. */
  readonly folder: string;
  /** Why the files could not be read, when they could not. */
  readonly problem: string | null;
}

const parseProfileSummary = (item: Json): ProfileSummary => ({
  profile: text(item.profile),
  source: text(item.source, "built-in"),
  editable: flag(item.editable),
  purpose: text(item.purpose),
  revision: count(item.revision),
  configuration: textOrNull(item.configuration),
  seats: count(item.seats),
  seatsOn: count(item.seatsOn),
  flows: strings(item.flows),
  defaultFlow: textOrNull(item.defaultFlow),
  folder: text(item.folder),
  problem: textOrNull(item.problem),
});

export function parseProfiles(body: unknown): ReadonlyArray<ProfileSummary> {
  return records(body)
    .map(parseProfileSummary)
    .filter((item) => item.profile.length > 0);
}

export const SEAT_DUTIES = ["plan", "build", "review", "qa"] as const;
export const SEAT_DUTY_LABEL: Readonly<Record<string, string>> = {
  plan: "Plans",
  build: "Builds",
  review: "Reviews",
  qa: "Tests",
};

export interface ProfileSeat {
  readonly id: string;
  readonly title: string;
  readonly role: string;
  readonly instructions: string;
  readonly active: boolean;
  readonly harness: string;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly access: string | null;
  readonly required: boolean;
  readonly focus: string;
  readonly duties: ReadonlyArray<string>;
}

/** A profile as it is edited: everything that can be set, in the words it was written in. */
export interface ProfileForm {
  readonly name: string;
  readonly purpose: string;
  readonly corePrompt: string;
  readonly defaultFlow: string;
  readonly memory: { readonly scope: string; readonly notes: string };
  readonly references: ReadonlyArray<string>;
  readonly lead: string;
  readonly seats: ReadonlyArray<ProfileSeat>;
  readonly tools: ReadonlyArray<string>;
  readonly specialists: ReadonlyArray<{ readonly name: string; readonly text: string }>;
  readonly qaMinimum: number;
  readonly workload: Readonly<Record<string, number>>;
}

export interface ProfileView extends ProfileSummary {
  readonly form: ProfileForm;
  readonly memoryScopes: Readonly<Record<string, string>>;
  readonly toolsOffered: ReadonlyArray<{
    readonly server: string;
    readonly offers: ReadonlyArray<string>;
    readonly onlyFor: string | null;
  }>;
  readonly harnesses: Readonly<Record<string, SeatOffer>>;
  readonly history: ReadonlyArray<{
    readonly revision: number;
    readonly by: string;
    readonly at: string;
    readonly note: string | null;
  }>;
  readonly note: string | null;
}

export function parseProfile(body: unknown): ProfileView | null {
  if (!isRecord(body) || text(body.name).length === 0 || !Array.isArray(body.seats)) return null;
  const memory = isRecord(body.memory) ? body.memory : {};
  const scopes = isRecord(memory.scopes) ? memory.scopes : {};
  const harnesses = isRecord(body.harnesses) ? body.harnesses : {};
  return {
    ...parseProfileSummary({ ...body, seats: body.seats.length }),
    form: {
      name: text(body.name),
      purpose: text(body.purpose),
      corePrompt: text(body.corePrompt),
      defaultFlow: text(body.defaultFlow, "chat"),
      memory: { scope: text(memory.scope, "conversation"), notes: text(memory.notes) },
      references: strings(body.references),
      lead: text(body.lead),
      seats: records(body.seats).map((seat) => ({
        id: text(seat.id),
        title: text(seat.title, text(seat.id)),
        role: text(seat.role),
        instructions: text(seat.instructions),
        active: seat.active !== false,
        harness: text(seat.harness),
        model: textOrNull(seat.model),
        reasoning: textOrNull(seat.reasoning),
        access: textOrNull(seat.access),
        required: flag(seat.required),
        focus: text(seat.focus),
        duties: strings(seat.duties),
      })),
      tools: strings(body.tools),
      specialists: records(body.specialists).map((item) => ({
        name: text(item.name),
        text: text(item.text),
      })),
      qaMinimum: count(body.qaMinimum) || 2,
      workload: shares(body.workload),
    },
    memoryScopes: Object.fromEntries(
      Object.entries(scopes).map(([scope, what]) => [scope, text(what)]),
    ),
    toolsOffered: records(body.toolsOffered).map((tool) => ({
      server: text(tool.server),
      offers: strings(tool.offers),
      onlyFor: textOrNull(tool.onlyFor),
    })),
    harnesses: Object.fromEntries(
      Object.entries(harnesses).map(([harness, takes]) => [harness, parseOffer(takes)]),
    ),
    history: records(body.history).map((entry) => ({
      revision: count(entry.revision),
      by: text(entry.by),
      at: text(entry.at),
      note: textOrNull(entry.note),
    })),
    note: textOrNull(body.note),
  };
}

/**
 * Where a tool of a seat stands. Configured is not working: a tool is shown
 * as working only after its server was started and answered.
 */
export type ToolState =
  | "working"
  | "incomplete"
  | "failed"
  | "not-checked"
  | "not-reachable"
  | "not-for-this-seat";

export const TOOL_STATE_LABEL: Readonly<Record<ToolState, string>> = {
  working: "Working",
  incomplete: "Answers, with tools missing",
  failed: "Failed",
  "not-checked": "Configured, not checked",
  "not-reachable": "Not reachable from this harness",
  "not-for-this-seat": "Not given to this seat",
};

const TOOL_STATES = Object.keys(TOOL_STATE_LABEL) as ReadonlyArray<ToolState>;

export interface SetupSeat {
  readonly seat: string;
  readonly title: string;
  readonly role: string;
  readonly on: boolean;
  readonly harness: string;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly access: string | null;
  readonly provider: string;
  readonly installed: boolean;
}

/** What a seat is really given, and what of it really works. */
export interface SeatSetup {
  readonly team: string;
  readonly source: string;
  readonly purpose: string;
  readonly configuration: string;
  readonly folder: string;
  readonly flow: string;
  readonly flows: ReadonlyArray<DeliveryFlow>;
  readonly problems: ReadonlyArray<string>;
  readonly seats: ReadonlyArray<SetupSeat>;
  readonly seat: SetupSeat;
  readonly memoryScope: string;
  readonly instructions: ReadonlyArray<{
    readonly name: string;
    readonly source: string;
    readonly file: string | null;
    /** Null for what the harness reads by itself. */
    readonly text: string | null;
    readonly note: string | null;
  }>;
  readonly tools: ReadonlyArray<{
    readonly server: string;
    readonly state: ToolState;
    readonly forThisSeat: boolean;
    readonly whyNotForThisSeat: string | null;
    readonly reachable: boolean;
    readonly route: string;
    readonly whyNotReachable: string | null;
    readonly runsAs: string;
    /** What the team's definition says the server offers. Not what it was seen to offer. */
    readonly declared: ReadonlyArray<string>;
    /** A check that was made for another setup, and so does not count for this one. */
    readonly checkedBefore: { readonly at: string; readonly why: string } | null;
    readonly checked: {
      readonly at: string;
      readonly connected: boolean;
      readonly exercised: boolean;
      readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>;
      readonly missing: ReadonlyArray<string>;
      readonly problem: string | null;
    } | null;
  }>;
  readonly specialists: ReadonlyArray<{
    readonly name: string;
    readonly purpose: string;
    readonly text: string;
    readonly file: string;
    /** `agent`: started by the engine. `subagent`: the harness's own. `prompt`: words only. */
    readonly kind: string;
    readonly how: string;
    readonly alsoInSessions: string | null;
    readonly host: {
      readonly seat: string;
      readonly harness: string;
      readonly model: string | null;
    } | null;
    readonly tools: ReadonlyArray<string>;
    readonly history: {
      readonly started: number;
      readonly done: number;
      readonly last: { readonly run: string; readonly at: string; readonly state: string } | null;
    };
  }>;
}

const parseSetupSeat = (value: unknown): SetupSeat => {
  const seat = isRecord(value) ? value : {};
  return {
    seat: text(seat.seat),
    title: text(seat.title, text(seat.seat)),
    role: text(seat.role),
    on: seat.on !== false,
    harness: text(seat.harness),
    model: textOrNull(seat.model),
    reasoning: textOrNull(seat.reasoning),
    access: textOrNull(seat.access),
    provider: text(seat.provider),
    installed: seat.installed !== false,
  };
};

export function parseSeatSetup(body: unknown): SeatSetup | null {
  if (!isRecord(body) || !isRecord(body.seat) || !Array.isArray(body.instructions)) return null;
  const memory = isRecord(body.memory) ? body.memory : {};
  return {
    team: text(body.team),
    source: text(body.source, "built-in"),
    purpose: text(body.purpose),
    configuration: text(body.configuration),
    folder: text(body.folder),
    flow: text(body.flow, "standard"),
    flows: parseFlows(body.flows),
    problems: strings(body.problems),
    seats: records(body.seats).map(parseSetupSeat),
    seat: parseSetupSeat(body.seat),
    memoryScope: text(memory.scope, "conversation"),
    instructions: records(body.instructions).map((layer) => ({
      name: text(layer.name),
      source: text(layer.source),
      file: textOrNull(layer.file),
      text: textOrNull(layer.text),
      note: textOrNull(layer.note),
    })),
    tools: records(body.tools).map((tool) => {
      const checked = isRecord(tool.checked) ? tool.checked : null;
      const state = TOOL_STATES.find((item) => item === tool.state) ?? "not-checked";
      return {
        server: text(tool.server),
        // A tool is never taken for working on the word of an answer that does not say so.
        state: state === "working" && !checked ? "not-checked" : state,
        forThisSeat: flag(tool.forThisSeat),
        whyNotForThisSeat: textOrNull(tool.whyNotForThisSeat),
        reachable: flag(tool.reachable),
        route: text(tool.route),
        whyNotReachable: textOrNull(tool.whyNotReachable),
        runsAs: text(tool.runsAs),
        declared: strings(tool.declared),
        checkedBefore: isRecord(tool.checkedBefore)
          ? { at: text(tool.checkedBefore.at), why: text(tool.checkedBefore.why) }
          : null,
        checked: checked
          ? {
              at: text(checked.at),
              connected: flag(checked.connected),
              exercised: flag(checked.exercised),
              tools: records(checked.tools).map((item) => ({
                name: text(item.name),
                description: text(item.description),
              })),
              missing: strings(checked.missing),
              problem: textOrNull(checked.problem),
            }
          : null,
      };
    }),
    specialists: records(body.specialists).map((item) => {
      const host = isRecord(item.host) ? item.host : null;
      const history = isRecord(item.history) ? item.history : {};
      const last = isRecord(history.last) ? history.last : null;
      return {
        name: text(item.name),
        purpose: text(item.purpose),
        text: text(item.text),
        file: text(item.file),
        kind: text(item.kind, "prompt"),
        how: text(item.how),
        alsoInSessions: textOrNull(item.alsoInSessions),
        host: host
          ? { seat: text(host.seat), harness: text(host.harness), model: textOrNull(host.model) }
          : null,
        tools: strings(item.tools),
        history: {
          started: count(history.started),
          done: count(history.done),
          last: last ? { run: text(last.run), at: text(last.at), state: text(last.state) } : null,
        },
      };
    }),
  };
}

/**
 * Which environment's engine the delivery screens talk to: the environment of the conversation a
 * task is made from, else the one the person chose, else the window's own; each only while still
 * available. An explicit choice never silently opens another environment's tasks.
 */
export function deliveryEnvironmentChoice<Id extends string>(input: {
  readonly fromConversation: string | null;
  readonly chosen: string | null;
  readonly requested?: string | null;
  readonly isReady?: boolean;
  readonly connected: ReadonlyArray<Id>;
  readonly primary: Id | null;
}): Id | null {
  if (input.isReady === false) return null;
  const known = (id: string | null | undefined): Id | null =>
    id ? (input.connected.find((environment) => environment === id) ?? null) : null;
  if (input.fromConversation) return known(input.fromConversation.split("/")[0]);
  if (input.requested) return known(input.requested);
  return known(input.chosen) ?? input.primary;
}

/**
 * The body of a request to the engine, as it travels: JSON. A field left `undefined`, such as an
 * optional choice nobody made, is not JSON, and the whole request would be refused before it is
 * sent ("Expected JSON value at body"). Such fields are dropped, as the engine would never see them.
 */
export function deliveryRequestBody(body: unknown): unknown {
  const text = JSON.stringify(body);
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}
