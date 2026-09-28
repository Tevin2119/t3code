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
}

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
    }));
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
  const seats = team.seats.filter((seat) => seat.harness === harness);
  if (seats.length === 0) {
    return {
      state: "blocked",
      team: team.team,
      why: `Team ${team.team} has no seat on this harness.`,
    };
  }
  const roles = [...new Set(seats.map((seat) => seat.role))];
  const wanted = input.role && roles.includes(input.role) ? input.role : null;
  if (!wanted && roles.length > 1) return { state: "choose-role", team: team.team, roles };
  const role = wanted ?? roles[0]!;
  const seat = seats.find((candidate) => candidate.role === role)!;
  if (!seat.available) {
    return { state: "blocked", team: team.team, why: seat.why ?? "This seat cannot be started." };
  }
  return { state: "ready", team: team.team, role };
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
  readonly working: boolean;
  readonly task: { readonly id: string; readonly state: string; readonly revision: number };
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
    readonly text: string;
  }>;
  readonly pendingFromPerson: number;
}

export function parseOrchestratorThread(body: unknown): OrchestratorThread | null {
  if (!isRecord(body) || text(body.kind) !== "orchestrator" || !isRecord(body.task)) return null;
  const council = isRecord(body.council) ? body.council : null;
  const concurrency = council && isRecord(council.concurrency) ? council.concurrency : {};
  return {
    thread: text(body.thread),
    team: text(body.team),
    title: text(body.title),
    working: flag(body.working),
    task: {
      id: text(body.task.id),
      state: text(body.task.state),
      revision: count(body.task.revision),
    },
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
  readonly updated: string;
}> {
  return records(body).map((item) => ({
    thread: text(item.thread),
    team: text(item.team),
    title: text(item.title),
    state: textOrNull(item.state),
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
