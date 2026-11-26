import {
  FirebaseHostingListing,
  type DeploymentCandidate,
  type DeploymentProject,
  type FirebaseHosting,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeListing = Schema.decodeUnknownOption(FirebaseHostingListing);
export const parseFirebaseListing = (body: unknown): FirebaseHostingListing | null =>
  Option.getOrNull(decodeListing(body));

/** The engine read of a branch's hosting targets; it fetches the branch, so it is never polled. */
export const firebaseListingPath = (repository: string, branch: string) =>
  `/api/repositories/${encodeURIComponent(repository)}/firebase?branch=${encodeURIComponent(branch)}`;

export const firebaseTargetValue = (firebase: FirebaseHosting) =>
  `${firebase.firebaseProject}:${firebase.target}`;

export function firebaseFromValue(value: string): FirebaseHosting | null {
  const [firebaseProject, target, ...rest] = value.split(":");
  return firebaseProject && target && rest.length === 0 ? { firebaseProject, target } : null;
}

/**
 * The targets a person can choose, as the engine listed them, and the ones it refused with its
 * own reason. Only a target the engine resolved to a site, with no problem, is offered.
 */
export function firebaseTargetChoices(listing: FirebaseHostingListing) {
  const items: { value: string; label: string }[] = [];
  const refused: { label: string; problem: string }[] = [];
  for (const row of listing.targets) {
    const name = `${row.target} · ${row.firebaseProject}`;
    if (row.problem || !row.site) {
      refused.push({ label: name, problem: row.problem ?? "The engine resolved no site." });
      continue;
    }
    const served = row.servedFolder ? `, serves ${row.servedFolder}/` : "";
    items.push({ value: firebaseTargetValue(row), label: `${name} → ${row.site}${served}` });
  }
  return { items, refused };
}

export const ADOPT_UNKNOWN = "unknown";
const short = (commit: string) => commit.slice(0, 10);

/**
 * What a person can say runs on a site with no release stamp: "unknown, accept once", or a
 * commit the engine already knows for this instance. The engine checks the commit is in the
 * candidate and refuses the candidate's own.
 */
export function adoptChoices(
  candidate: DeploymentCandidate,
  candidates: ReadonlyArray<DeploymentCandidate>,
) {
  const commits = new Map<string, string>();
  const add = (commit: string | null | undefined, why: string) => {
    if (commit && commit !== candidate.commit && !commits.has(commit)) commits.set(commit, why);
  };
  add(candidate.baseCommit, "this release's base");
  for (const other of candidates) {
    if (other.projectId === candidate.projectId && other.id !== candidate.id)
      add(other.commit, other.subject || `release ${other.seq ?? other.id}`);
  }
  return [
    { value: ADOPT_UNKNOWN, label: "Unknown, accept once" },
    ...[...commits].map(([commit, why]) => ({ value: commit, label: `${short(commit)} · ${why}` })),
  ];
}

export function adapterLabel(project: Pick<DeploymentProject, "adapter" | "firebase">): string {
  if (project.adapter === "engine") return "Built-in engine";
  if (project.adapter === "command") return "Repository commands";
  return project.firebase
    ? `Firebase Hosting · ${project.firebase.target} · ${project.firebase.firebaseProject}`
    : "Firebase Hosting";
}
