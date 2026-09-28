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

export interface SeatSettingValues {
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly access: string | null;
}

/** What may be set for one seat, what the team defines, and what is set for a thread. */
export interface SeatSettings {
  readonly seat: string;
  readonly harness: string;
  readonly now: SeatSettingValues;
  readonly may: {
    readonly model: boolean;
    readonly reasoning: ReadonlyArray<string>;
    readonly access: ReadonlyArray<string>;
  };
  readonly why: SeatSettingValues;
  readonly set: Partial<Record<"model" | "reasoning" | "access", string>>;
  readonly effective: SeatSettingValues;
}

const parseValues = (value: unknown): SeatSettingValues => {
  const from = isRecord(value) ? value : {};
  return {
    model: textOrNull(from.model),
    reasoning: textOrNull(from.reasoning),
    access: textOrNull(from.access),
  };
};

export const parseSeatSettings = (value: Json): SeatSettings => {
  const may = isRecord(value.may) ? value.may : {};
  const set = isRecord(value.set) ? value.set : {};
  const now = parseValues(value.now);
  return {
    seat: text(value.seat),
    harness: text(value.harness),
    now,
    may: { model: flag(may.model), reasoning: strings(may.reasoning), access: strings(may.access) },
    why: parseValues(value.why),
    set: Object.fromEntries(
      (["model", "reasoning", "access"] as const)
        .filter((key) => typeof set[key] === "string" && set[key] !== "")
        .map((key) => [key, String(set[key])]),
    ),
    effective: value.effective === undefined ? now : parseValues(value.effective),
  };
};

const parseWorkflows = (value: unknown): ReadonlyArray<DeliveryWorkflow> =>
  records(value).map((item) => ({
    id: text(item.id),
    title: text(item.title, text(item.id)),
    stages: strings(item.stages),
    stop: text(item.stop),
  }));

const parseSeat = (value: Json): DeliverySeat => ({
  seat: text(value.seat),
  role: text(value.role),
  harness: text(value.harness),
  model: textOrNull(value.model),
  provider: text(value.provider),
  required: flag(value.required),
  available: flag(value.available),
  why: textOrNull(value.why),
  tools: strings(value.tools),
});

export function parseTeams(body: unknown): ReadonlyArray<DeliveryTeam> {
  return records(body)
    .filter((team) => text(team.team).length > 0)
    .map((team) => ({
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
    }));
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

/** Only what differs from what the team defines is sent as a setting for a run. */
export function seatSettingsToSend(
  settings: ReadonlyArray<SeatSettings>,
  chosen: Readonly<Record<string, Partial<Record<"model" | "reasoning" | "access", string>>>>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const item of settings) {
    const asked = chosen[item.seat] ?? {};
    const kept = Object.entries(asked).filter(([key, value]) => {
      if (typeof value !== "string" || value.trim() === "") return false;
      return value.trim() !== (item.now[key as keyof SeatSettingValues] ?? "");
    });
    if (kept.length > 0) {
      out[item.seat] = Object.fromEntries(kept.map(([key, value]) => [key, String(value).trim()]));
    }
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

export interface DeliveryCard {
  readonly id: string;
  readonly title: string;
  readonly team: string;
  readonly lane: string;
  readonly state: string;
  readonly revision: number;
  readonly origin: string;
  readonly parts: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly lane: string | null;
  }>;
  readonly followUps: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly state: string;
  }>;
  readonly run: {
    readonly id: string;
    readonly state: string;
    readonly stage: string;
    readonly candidate: string | null;
    readonly configuration: string;
  } | null;
  readonly paused: {
    readonly kind: string;
    readonly why: string;
    readonly nextTry: string | null;
    readonly needsPerson: boolean;
  } | null;
  readonly findings: { readonly open: number; readonly all: number };
  readonly approvals: ReadonlyArray<{
    readonly actor: string;
    readonly decision: string;
    readonly stands: boolean;
  }>;
  readonly actions: ReadonlyArray<string>;
}

export interface DeliveryBoard {
  readonly view: string;
  readonly views: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly lanes: ReadonlyArray<{
    readonly lane: string;
    readonly title: string;
    readonly cards: ReadonlyArray<DeliveryCard>;
  }>;
  readonly notices: ReadonlyArray<{
    readonly key: string;
    readonly kind: string;
    readonly text: string;
    readonly count: number;
  }>;
  readonly note: string | null;
}

const parseCard = (value: Json): DeliveryCard => {
  const run = isRecord(value.run) ? value.run : null;
  const paused = isRecord(value.paused) ? value.paused : null;
  const findings = isRecord(value.findings) ? value.findings : {};
  return {
    id: text(value.id),
    title: text(value.title),
    team: text(value.team),
    lane: text(value.lane),
    state: text(value.state),
    revision: count(value.revision),
    origin: text(value.origin),
    parts: records(value.parts).map((part) => ({
      id: text(part.id),
      title: text(part.title),
      lane: textOrNull(part.lane),
    })),
    followUps: records(value.followUps).map((item) => ({
      id: text(item.id),
      title: text(item.title),
      state: text(item.state),
    })),
    run: run
      ? {
          id: text(run.id),
          state: text(run.state),
          stage: text(run.stage),
          candidate: textOrNull(run.candidate),
          configuration: text(run.configuration),
        }
      : null,
    paused: paused
      ? {
          kind: text(paused.kind),
          why: text(paused.why),
          nextTry: textOrNull(paused.nextTry),
          needsPerson: flag(paused.needsPerson),
        }
      : null,
    findings: { open: count(findings.open), all: count(findings.all) },
    approvals: records(value.approvals).map((approval) => ({
      actor: text(approval.actor),
      decision: text(approval.decision),
      stands: flag(approval.stands),
    })),
    actions: strings(value.actions),
  };
};

export function parseBoard(body: unknown): DeliveryBoard | null {
  if (!isRecord(body) || !Array.isArray(body.lanes)) return null;
  return {
    view: text(body.view),
    views: records(body.views).map((view) => ({ id: text(view.id), title: text(view.title) })),
    lanes: records(body.lanes).map((lane) => ({
      lane: text(lane.lane),
      title: text(lane.title),
      cards: records(lane.cards).map(parseCard),
    })),
    notices: records(body.notices).map((notice) => ({
      key: text(notice.key),
      kind: text(notice.kind),
      text: text(notice.text),
      count: count(notice.count),
    })),
    note: textOrNull(body.note),
  };
}

export interface CouncilSeat {
  readonly seat: string;
  readonly role: string;
  readonly harness: string;
  readonly provider: string;
  readonly required: boolean;
  readonly requestedModel: string | null;
  readonly actualModel: string | null;
  readonly activity: string;
  readonly blockedBy: string | null;
  readonly stage: string | null;
  readonly verdict: string | null;
  readonly attempts: number;
}

export interface OrchestratorThread {
  readonly thread: string;
  readonly team: string;
  readonly title: string;
  /** `draft` until a person starts it. Nothing runs for a draft. */
  readonly state: "draft" | "started";
  readonly draft: { readonly text: string } | null;
  readonly workflow: string;
  readonly workflows: ReadonlyArray<DeliveryWorkflow>;
  readonly configuration: string;
  readonly settings: ReadonlyArray<SeatSettings>;
  readonly working: boolean;
  /** Null while the thread is a draft. */
  readonly task: { readonly id: string; readonly state: string; readonly revision: number } | null;
  readonly parts: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly state: string;
  }>;
  readonly roster: ReadonlyArray<DeliverySeat>;
  readonly children: ReadonlyArray<{
    readonly run: string;
    readonly state: string;
    readonly stage: string;
    readonly whole: boolean;
  }>;
  readonly council: {
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
  } | null;
  readonly messages: ReadonlyArray<{
    readonly seq: number;
    readonly at: string;
    readonly from: string;
    /** `question`, `change`, `answer`, `start`, or null for the coordinator's own notes. */
    readonly kind: string | null;
    readonly text: string;
  }>;
  readonly pendingFromPerson: number;
}

export function parseOrchestratorThread(body: unknown): OrchestratorThread | null {
  if (!isRecord(body) || text(body.kind) !== "orchestrator") return null;
  const task = isRecord(body.task) ? body.task : null;
  const draft = isRecord(body.draft) ? body.draft : null;
  const council = isRecord(body.council) ? body.council : null;
  const concurrency = council && isRecord(council.concurrency) ? council.concurrency : {};
  return {
    thread: text(body.thread),
    team: text(body.team),
    title: text(body.title),
    // A thread from an engine that knows no drafts has started.
    state: text(body.state) === "draft" ? "draft" : "started",
    draft: draft ? { text: text(draft.text) } : null,
    workflow: text(body.workflow, "standard"),
    workflows: parseWorkflows(body.workflows),
    configuration: text(body.configuration),
    settings: records(body.settings).map(parseSeatSettings),
    working: flag(body.working),
    task: task
      ? { id: text(task.id), state: text(task.state), revision: count(task.revision) }
      : null,
    parts: records(body.parts).map((part) => ({
      id: text(part.id),
      title: text(part.title),
      state: text(part.state),
    })),
    roster: records(body.roster).map(parseSeat),
    children: records(body.children).map((child) => ({
      run: text(child.run),
      state: text(child.state),
      stage: text(child.stage),
      whole: flag(child.whole),
    })),
    council: council
      ? {
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
        }
      : null,
    messages: records(body.messages).map((message) => ({
      seq: count(message.seq),
      at: text(message.at),
      from: text(message.from),
      kind: textOrNull(message.kind),
      text: text(message.text),
    })),
    pendingFromPerson: count(body.pendingFromPerson),
  };
}

export function parseThreadList(body: unknown): ReadonlyArray<{
  readonly thread: string;
  readonly team: string;
  readonly title: string;
  readonly state: string | null;
  readonly taskState: string | null;
  readonly updated: string;
}> {
  return records(body).map((item) => ({
    thread: text(item.thread),
    team: text(item.team),
    title: text(item.title),
    state: textOrNull(item.state),
    taskState: textOrNull(item.taskState),
    updated: text(item.updated),
  }));
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
