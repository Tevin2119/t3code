import { projectChangeRequestUrl } from "@t3tools/client-runtime/change-request-links";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  DeploymentCompare,
  type DeploymentCandidate,
  type DeploymentComparePullRequest,
  type DeploymentProject,
  type DeploymentPromotion,
  type DeploymentPromotionAction,
  type DeploymentsSnapshot,
  type RepositoryIdentity,
  type TaskDeploymentPublication,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeCompare = Schema.decodeUnknownOption(DeploymentCompare);
export const parseDeploymentCompare = (body: unknown): DeploymentCompare | null =>
  Option.getOrNull(decodeCompare(body));

export const comparePath = (from: string, to: string) =>
  `/api/deployments/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

export type ReleaseLineView = {
  repository: string;
  title: string;
  problem: string | null;
  instances: ReadonlyArray<DeploymentProject>;
};

/**
 * One line per repository, in the engine's promotion order. An engine older than release lines
 * sends no `lines`; its projects then keep the order it listed them in.
 */
export function releaseLinesOf(
  snapshot: Pick<DeploymentsSnapshot, "projects" | "repositories"> & {
    lines?: DeploymentsSnapshot["lines"];
  },
): ReleaseLineView[] {
  const byId = new Map(snapshot.projects.map((project) => [project.id, project]));
  const titleOf = (repository: string, instances: ReadonlyArray<DeploymentProject>) =>
    snapshot.repositories.find((entry) => entry.id === repository)?.title ??
    instances[0]?.title ??
    repository;
  const lines: ReleaseLineView[] = (snapshot.lines ?? []).map((line) => {
    const instances = line.instances.flatMap((id) => byId.get(id) ?? []);
    return {
      repository: line.repository,
      title: titleOf(line.repository, instances),
      problem: line.problem,
      instances,
    };
  });
  // Anything a line did not place keeps its repository's line, after what was placed.
  const placed = new Set(lines.flatMap((line) => line.instances.map((project) => project.id)));
  for (const project of snapshot.projects) {
    if (placed.has(project.id)) continue;
    const line = lines.find((entry) => entry.repository === project.repository);
    if (line) line.instances = [...line.instances, project];
    else
      lines.push({
        repository: project.repository,
        title: titleOf(project.repository, [project]),
        problem: null,
        instances: [project],
      });
  }
  return lines;
}

/** Whether the strip between two neighbours compares them: the upper one promotes into the lower. */
export const promotesInto = (from: DeploymentProject, to: DeploymentProject) =>
  !!from.promotesTo && from.promotesTo === to.environment && from.repository === to.repository;

export type InstanceTone = "live" | "waiting" | "problem" | "unknown" | "busy";

export type InstanceFacts = {
  tone: InstanceTone;
  chip: string;
  target: string | null;
  servedFolder: string | null;
  live: {
    commit: string | null;
    observedAt: string | null;
    by: { name: string; how: "deployed" | "adopted" } | null;
  };
  waiting: { commit: string; state: DeploymentCandidate["state"] | null } | null;
};

function servedFolderOf(candidates: ReadonlyArray<DeploymentCandidate>, live: string | null) {
  // The live candidate's qualification names the folder it serves; else the newest candidate's.
  // The engine lists an instance's candidates newest first.
  const ordered = [...candidates.filter((candidate) => candidate.id === live), ...candidates];
  for (const candidate of ordered) {
    const folder = (candidate.evidence as { servedFolder?: unknown } | null)?.servedFolder;
    if (typeof folder === "string") return folder;
  }
  return null;
}

function deployedBy(candidate: DeploymentCandidate | undefined): string | null {
  for (const event of (candidate?.events ?? []).toReversed()) {
    const entry = event as { type?: unknown; by?: unknown } | null;
    if (entry?.type === "deploying" && typeof entry.by === "string" && entry.by.trim())
      return entry.by;
  }
  return null;
}

/** What one instance card shows, all of it as the engine reported it. */
export function instanceFacts(
  project: DeploymentProject,
  allCandidates: ReadonlyArray<DeploymentCandidate>,
): InstanceFacts {
  const candidates = allCandidates.filter((candidate) => candidate.projectId === project.id);
  const liveCandidate = candidates.find((candidate) => candidate.id === project.liveCandidate);
  const adopted =
    !!project.liveAdoptedBy &&
    (!project.liveAdoptedCommit || project.liveAdoptedCommit === project.liveCommit);
  const deployer = deployedBy(liveCandidate);
  const by = adopted
    ? { name: project.liveAdoptedBy!, how: "adopted" as const }
    : deployer
      ? { name: deployer, how: "deployed" as const }
      : null;
  const waiting =
    project.latestCommit && project.latestCommit !== project.liveCommit
      ? {
          commit: project.latestCommit,
          state:
            candidates.find((candidate) => candidate.commit === project.latestCommit)?.state ??
            null,
        }
      : null;
  const problem = project.liveProblem ?? project.problem ?? null;
  const [tone, chip]: [InstanceTone, string] = problem
    ? ["problem", "Problem"]
    : project.busy
      ? ["busy", "Releasing"]
      : !project.liveCommit
        ? ["unknown", "Nothing known live"]
        : waiting
          ? ["waiting", "Work waiting"]
          : ["live", "Live"];
  return {
    tone,
    chip,
    target: project.firebase
      ? `${project.firebase.firebaseProject} · ${project.firebase.target}`
      : null,
    servedFolder: servedFolderOf(candidates, project.liveCandidate ?? null),
    live: { commit: project.liveCommit, observedAt: project.liveObservedAt ?? null, by },
    waiting,
  };
}

/** The T3 project that has the engine repository's folder checked out, if T3 knows one. */
export function repositoryIdentityFor(
  path: string | null | undefined,
  projects: ReadonlyArray<{
    workspaceRoot: string;
    repositoryIdentity?: RepositoryIdentity | null | undefined;
  }>,
): RepositoryIdentity | null {
  if (!path) return null;
  const clean = (value: string) => value.replace(/\/+$/, "");
  const target = clean(path);
  for (const project of projects) {
    const identity = project.repositoryIdentity;
    if (!identity) continue;
    if (clean(project.workspaceRoot) === target || clean(identity.rootPath ?? "") === target)
      return identity;
  }
  return null;
}

/**
 * The PR's own URL from the engine, else the one its repository's host gives for its number.
 * Null when neither is known: the row then cannot open the PR.
 */
export function pullRequestUrl(
  pr: Pick<DeploymentComparePullRequest, "url" | "number">,
  identity: RepositoryIdentity | null,
): string | null {
  if (pr.url) return pr.url;
  if (pr.number === null || !identity) return null;
  const repository = sourceControlClients.repositorySelector(identity);
  return repository ? projectChangeRequestUrl(identity, repository, pr.number) : null;
}

const SECTION_ROWS = 8;

/** The rows a section shows, and how many it leaves out. */
export function shownRows<T>(rows: ReadonlyArray<T>, limit = SECTION_ROWS) {
  return { rows: rows.slice(0, limit), hidden: Math.max(0, rows.length - limit) };
}

/** "Live on qa, not on app": a task on each instance of its repository, in line order. */
export function taskInstancesSummary(
  instances: TaskDeploymentPublication["instances"],
): string | null {
  if (!instances?.length) return null;
  const of = (state: "live" | "waiting" | "absent") =>
    instances.filter((entry) => entry.state === state).map((entry) => entry.environment);
  const live = of("live");
  const waiting = of("waiting");
  const absent = of("absent");
  const parts = [
    live.length ? `Live on ${live.join(", ")}` : null,
    waiting.length ? `merged, waiting on ${waiting.join(", ")}` : null,
    absent.length ? `not on ${absent.join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  const text = parts.join(", ");
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : null;
}

const PROMOTIONS_PATH = "/api/deployments/promotions";
const promotionActionPath = (id: string) => `${PROMOTIONS_PATH}/${encodeURIComponent(id)}/action`;

const FINISHED = new Set(["promoted", "cancelled"]);

/** The promotion the strip shows: the open one into `to`, else the latest from `from` into it. */
export function stripPromotion(
  promotions: ReadonlyArray<DeploymentPromotion> | undefined,
  from: string,
  to: string,
): DeploymentPromotion | null {
  const pair = (promotions ?? [])
    .filter((promotion) => promotion.to === to && promotion.from === from)
    .toSorted((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return pair.find((promotion) => !FINISHED.has(promotion.state)) ?? pair[0] ?? null;
}

const STATE_VIEWS: Record<
  string,
  { label: string; tone: InstanceTone; actions: ReadonlyArray<DeploymentPromotionAction> }
> = {
  planned: { label: "Planned", tone: "waiting", actions: ["cancel"] },
  syncing: { label: "Syncing hotfixes", tone: "busy", actions: [] },
  conflicted: { label: "Conflicted", tone: "problem", actions: ["retry", "cancel"] },
  "awaiting-qa": { label: "Awaiting QA", tone: "waiting", actions: ["cancel"] },
  ready: { label: "Ready to advance", tone: "waiting", actions: ["advance", "cancel"] },
  advancing: { label: "Advancing", tone: "busy", actions: [] },
  promoted: { label: "Promoted", tone: "live", actions: [] },
  blocked: { label: "Blocked", tone: "problem", actions: ["retry", "cancel"] },
  cancelled: { label: "Cancelled", tone: "unknown", actions: [] },
};

export type PromotionView = {
  label: string;
  tone: InstanceTone;
  /** The engine's words, as it wrote them. */
  reason: string | null;
  actions: ReadonlyArray<DeploymentPromotionAction>;
  open: boolean;
};

/**
 * What the strip shows for a promotion. A state this T3 does not know shows by its name; it is
 * offered cancel as its way out, which the engine refuses if that state cannot be cancelled.
 */
export function promotionView(promotion: DeploymentPromotion): PromotionView {
  const known = Object.hasOwn(STATE_VIEWS, promotion.state)
    ? STATE_VIEWS[promotion.state]
    : undefined;
  const open = !FINISHED.has(promotion.state);
  return {
    label: known?.label ?? promotion.state,
    tone: known?.tone ?? "unknown",
    reason: promotion.problem ?? promotion.waiting ?? null,
    actions: known?.actions ?? (open ? ["cancel"] : []),
    open,
  };
}

const short12 = (commit: string | null | undefined) => (commit ? commit.slice(0, 12) : null);

export type PromotionConfirm = {
  title: string;
  /** What moves: from which commit to which branch. */
  moves: string;
  submit: string;
  path: string;
  body: Record<string, unknown>;
};

const rangeCommits = (range: DeploymentCompare["ahead"]) => {
  const commits = [...range.prs, ...range.loose].map((row) => row.commit);
  // Only a complete range answers "is every commit there"; a truncated one is not trusted.
  return !range.truncated && commits.length === range.count ? new Set(commits) : null;
};

/**
 * Why a new promotion would be refused now, or null. The engine moves `to`'s branch tip, not
 * what runs there: once that tip holds `from`'s live commit there is nothing to promote until
 * `to` deploys it, even though compare's ahead range (against `to`'s live) still lists it.
 */
export function promoteBlocked(compare: DeploymentCompare): string | null {
  if (compare.promote === "sync-hotfixes-first") return null;
  const { from, to, points } = compare;
  const waiting = `${to.branch} already holds ${from.environment}'s live commit ${short12(points.fromLive)}. Waiting for ${to.environment} to deploy it.`;
  if (points.fromLive && points.fromLive === points.toTip) return waiting;
  if (compare.ahead.count === 0)
    return `Nothing on ${from.environment} is missing from ${to.environment}.`;
  const ahead = rangeCommits(compare.ahead);
  const onTip = rangeCommits(compare.waiting);
  if (ahead && onTip && [...ahead].every((commit) => onTip.has(commit))) return waiting;
  return null;
}

/** Why the difference cannot back a promotion right now, or null when it is fresh. */
export function compareReadingProblem(reading: {
  error: string | null;
  stale: boolean;
  hasCompare: boolean;
}): string | null {
  if (reading.error) return `The difference could not be read: ${reading.error}`;
  if (!reading.hasCompare) return "The difference has not been read yet.";
  if (reading.stale) return "The difference is out of date. It is read again shortly.";
  return null;
}

/**
 * Whether a confirmation shows a reading taken after it opened: the engine takes no expected
 * commits, so what the dialog shows must be what it will read.
 */
const readAfterOpening = (openedAt: string | null, readAt: string | null) =>
  !!readAt && readAt !== openedAt && (!openedAt || readAt > openedAt);

/** Promote, or sync hotfixes first: one request, whose plan the engine makes from fresh reads. */
export function promoteConfirm(
  compare: DeploymentCompare,
  to: Pick<DeploymentProject, "mode">,
): PromotionConfirm {
  const { from, to: target, points } = compare;
  const body = { from: from.id, to: target.id };
  if (compare.promote === "sync-hotfixes-first") {
    const count = compare.hotfixes.count;
    const then =
      to.mode === "full-auto"
        ? `${target.environment} is full auto, so ${target.branch} then moves on its own.`
        : `Then it waits, ready, for a named person to advance ${target.branch}.`;
    return {
      title: `Sync hotfixes into ${from.environment} first`,
      moves: `Merges ${target.branch} (${short12(points.toTip) ?? "its tip"}, ${count === 1 ? "1 commit" : `${count} commits`} ${from.environment} lacks) into ${from.branch} (${short12(points.fromTip) ?? "its tip"}) and pushes the merge to ${from.branch}. ${target.branch} moves only once ${from.environment} runs and verifies that sync. ${then}`,
      submit: "Sync first",
      path: PROMOTIONS_PATH,
      body,
    };
  }
  const live = short12(points.fromLive);
  return {
    title: `Promote ${from.environment} into ${target.environment}`,
    moves: live
      ? `Moves ${target.branch} to ${from.environment}'s verified live commit ${live}, with a plain push that is never forced.`
      : `${from.environment} has no verified live commit yet. The promotion waits until it has one, then moves ${target.branch} to it.`,
    submit: "Promote",
    path: PROMOTIONS_PATH,
    body,
  };
}

const ACTION_LABELS: Record<DeploymentPromotionAction, string> = {
  advance: "Advance",
  retry: "Retry",
  cancel: "Cancel promotion",
};
export const promotionActionLabel = (action: DeploymentPromotionAction) => ACTION_LABELS[action];

/** An action the engine offers on an open promotion. */
export function promotionActionConfirm(
  promotion: DeploymentPromotion,
  action: DeploymentPromotionAction,
  names: { from: string; to: string; toBranch: string },
): PromotionConfirm {
  const path = promotionActionPath(promotion.id);
  const body = { action };
  if (action === "advance") {
    return {
      title: `Advance ${names.to}`,
      moves: `Moves ${names.toBranch} to ${short12(promotion.source) ?? "the verified commit"}, ${names.from}'s verified live commit, with a plain push that is never forced.`,
      submit: "Advance",
      path,
      body,
    };
  }
  if (action === "retry") {
    return {
      title: "Retry the promotion",
      moves: `Reads ${names.from} and ${names.to} again. Nothing is pushed until the checks pass.`,
      submit: "Retry",
      path,
      body,
    };
  }
  return {
    title: "Cancel the promotion",
    moves: `Withdraws the promotion of ${names.from} into ${names.to}. Nothing already pushed is undone.`,
    submit: "Cancel promotion",
    path,
    body,
  };
}

export type PendingConfirm =
  | { kind: "promote"; openedAt: string | null }
  | { kind: "action"; action: DeploymentPromotionAction; openedAt: string | null };

export type ConfirmationState =
  | { state: "reading" }
  | { state: "problem"; why: string }
  | { state: "ready"; confirm: PromotionConfirm };

/**
 * What an open confirmation shows. Anything that moves a branch waits for the difference read
 * after the dialog opened and is built from it; retry and cancel do not rest on it.
 */
export function promotionConfirmation(input: {
  pending: PendingConfirm;
  readAt: string | null;
  error: string | null;
  compare: DeploymentCompare | null;
  promotion: DeploymentPromotion | null;
  to: Pick<DeploymentProject, "mode" | "environment" | "branch">;
  from: Pick<DeploymentProject, "environment">;
}): ConfirmationState {
  const { pending, compare, promotion } = input;
  if (pending.kind === "action" && !promotion)
    return { state: "problem", why: "This promotion is no longer listed." };
  const movesBranch = pending.kind === "promote" || pending.action === "advance";
  if (movesBranch) {
    if (input.error)
      return { state: "problem", why: `The difference could not be read: ${input.error}` };
    if (!readAfterOpening(pending.openedAt, input.readAt) || !compare) return { state: "reading" };
  }
  if (pending.kind === "promote") {
    const why = promoteBlocked(compare!);
    return why
      ? { state: "problem", why }
      : { state: "ready", confirm: promoteConfirm(compare!, input.to) };
  }
  return {
    state: "ready",
    confirm: promotionActionConfirm(promotion!, pending.action, {
      from: input.from.environment,
      to: input.to.environment,
      toBranch: input.to.branch,
    }),
  };
}
