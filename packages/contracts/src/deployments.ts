import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const DEPLOYMENT_STATES = [
  "merged",
  "qualifying",
  "ready",
  "deploying",
  "verifying",
  "live",
  "blocked",
  "superseded",
] as const;
export const DeploymentState = Schema.Literals(DEPLOYMENT_STATES);
export const DeploymentMode = Schema.Literals(["manual", "auto-qualify", "full-auto"]);
export const DeploymentAdapter = Schema.Literals(["engine", "command", "firebase-hosting"]);
export type DeploymentAdapter = typeof DeploymentAdapter.Type;
export const DeploymentAction = Schema.Literals([
  "qualify",
  "deploy",
  "retry",
  "cancel",
  "verify",
  "adopt",
]);
export type DeploymentAction = typeof DeploymentAction.Type;
const Revision = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/));
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const Problem = Schema.optional(Schema.NullOr(Schema.String));

const CommandArgv = Schema.Array(Schema.String).check(
  Schema.isMinLength(1),
  Schema.makeFilter((args) => !!args[0]?.trim(), {
    expected: "an executable followed by arguments",
  }),
);
export const DeploymentCommands = Schema.Struct({
  setup: Schema.optional(CommandArgv),
  qualify: CommandArgv,
  deploy: CommandArgv,
  verify: CommandArgv,
});
/** The firebase-hosting preset runs its own deploy and verify; only these checks are its own. */
export const FirebaseHostingCommands = Schema.Struct({
  setup: Schema.optional(CommandArgv),
  qualify: Schema.optional(CommandArgv),
});
// The saved steps as the engine reports them, for any adapter.
const SavedCommands = Schema.Struct({
  setup: Schema.optional(CommandArgv),
  qualify: Schema.optional(CommandArgv),
  deploy: Schema.optional(CommandArgv),
  verify: Schema.optional(CommandArgv),
});

// The engine's own patterns for the two saved Firebase fields; it checks them again.
export const FirebaseHosting = Schema.Struct({
  firebaseProject: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/)),
  target: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,62}$/)),
});
export type FirebaseHosting = typeof FirebaseHosting.Type;

/** A branch's Firebase Hosting targets, read by the engine at the fetched tip. */
export const FirebaseHostingListing = Schema.Struct({
  repository: Schema.String,
  branch: Schema.String,
  commit: Schema.String,
  aliases: Schema.Record(Schema.String, Schema.String),
  targets: Schema.Array(
    Schema.Struct({
      firebaseProject: Schema.String,
      target: Schema.String,
      sites: Schema.Array(Schema.String),
      site: Schema.NullOr(Schema.String),
      servedFolder: Schema.NullOr(Schema.String),
      hooks: Schema.Array(Schema.String),
      problem: Schema.NullOr(Schema.String),
    }),
  ),
  problems: Schema.Array(Schema.String),
});
export type FirebaseHostingListing = typeof FirebaseHostingListing.Type;
const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

export const DeploymentProject = Schema.Struct({
  id: Identifier,
  repository: TrimmedNonEmptyString,
  title: Schema.String,
  branch: TrimmedNonEmptyString,
  environment: TrimmedNonEmptyString,
  mode: DeploymentMode,
  adapter: DeploymentAdapter,
  latestCommit: Schema.NullOr(Revision),
  liveCommit: Schema.NullOr(Revision),
  problem: Problem,
  liveProblem: Problem,
  liveObservedAt: Schema.optional(Schema.NullOr(Schema.String)),
  commands: Schema.optional(Schema.NullOr(SavedCommands)),
  firebase: Schema.optional(Schema.NullOr(FirebaseHosting)),
  // Live facts as the engine derived them; T3 shows them and derives none.
  liveCandidate: Schema.optional(Schema.NullOr(Schema.String)),
  liveSite: OptionalText,
  configuredSite: OptionalText,
  liveAdoptedBy: OptionalText,
  liveAdoptedAt: OptionalText,
  liveAdoptedCommit: OptionalText,
  liveAdoptedSite: OptionalText,
  busy: Schema.optional(Schema.Boolean),
});
export type DeploymentProject = typeof DeploymentProject.Type;
export const DeploymentCandidate = Schema.Struct({
  id: Identifier,
  projectId: Identifier,
  commit: Revision,
  baseCommit: Schema.NullOr(Revision),
  state: DeploymentState,
  phase: Schema.optional(Schema.NullOr(Schema.String)),
  seq: Schema.optional(Schema.Number),
  subject: Schema.optional(Schema.NullOr(Schema.String)),
  failedPhase: Schema.optional(Schema.NullOr(Schema.String)),
  resumeState: Schema.optional(Schema.NullOr(Schema.String)),
  // The name of whoever asked; the engine stops at its next safe point.
  cancelRequested: Schema.optional(Schema.NullOr(Schema.String)),
  attempts: Schema.optional(Schema.Struct({ qualify: Schema.Number, deploy: Schema.Number })),
  liveAt: Schema.optional(Schema.NullOr(Schema.String)),
  liveUntil: Schema.optional(Schema.NullOr(Schema.String)),
  needsVerify: Schema.optional(Schema.Boolean),
  // The branch it was made from; work of a branch no longer watched is parked.
  branch: Schema.optional(Schema.String),
  // Where the engine recorded it deployed or adopted; any entry means it was deployed.
  deployedTo: Schema.optional(Schema.Array(Schema.Unknown)),
  awaitingRestart: Schema.optional(Schema.Boolean),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  problem: Problem,
  evidence: Schema.Unknown,
  events: Schema.Array(Schema.Unknown),
  dependencies: Schema.optional(Schema.Unknown),
});
export type DeploymentCandidate = typeof DeploymentCandidate.Type;
export const DeploymentsSnapshot = Schema.Struct({
  problem: Problem,
  version: Schema.Literal(1),
  projects: Schema.Array(DeploymentProject),
  candidates: Schema.Array(DeploymentCandidate),
  repositories: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      title: Schema.String,
      path: Schema.String,
      defaultBase: Schema.NullOr(Schema.String),
      branches: Schema.Array(Schema.String),
      kind: Schema.String,
      ok: Schema.Boolean,
      // The built-in adapter can release this repository: it is the engine's own checkout.
      engineAdapter: Schema.optional(Schema.Boolean),
    }),
  ),
  capabilities: Schema.Struct({
    engine: Schema.Boolean,
    command: Schema.Boolean,
    "firebase-hosting": Schema.optional(Schema.Boolean),
  }),
});
export type DeploymentsSnapshot = typeof DeploymentsSnapshot.Type;
// Deployment mutations need the direct approval key; an open approval window is not enough.
const Approval = { by: TrimmedNonEmptyString, key: Schema.String.check(Schema.isMinLength(1)) };
export const DeploymentProjectInput = Schema.Struct({
  repository: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  environment: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,39}$/)),
  mode: DeploymentMode,
  adapter: DeploymentAdapter,
  ...Approval,
  confirmed: Schema.optional(Schema.Boolean),
  commands: Schema.optional(Schema.Union([DeploymentCommands, FirebaseHostingCommands])),
  firebase: Schema.optional(FirebaseHosting),
}).check(
  Schema.makeFilter((input) => input.adapter !== "engine" || input.environment === "production", {
    expected: "production for the built-in engine adapter",
  }),
  Schema.makeFilter((input) => input.mode !== "full-auto" || input.confirmed === true, {
    expected: "explicit consent for full-auto mode",
  }),
  Schema.makeFilter((input) => (input.adapter === "firebase-hosting") === !!input.firebase, {
    expected: "a Firebase project and hosting target exactly for the firebase-hosting adapter",
  }),
  Schema.makeFilter(
    (input) =>
      input.adapter !== "firebase-hosting" ||
      !input.commands ||
      (!("deploy" in input.commands) && !("verify" in input.commands)),
    { expected: "no deploy or verify step for the firebase-hosting adapter" },
  ),
  Schema.makeFilter(
    (input) =>
      input.adapter !== "command" ||
      !input.commands ||
      ("qualify" in input.commands && "deploy" in input.commands && "verify" in input.commands),
    { expected: "qualify, deploy and verify steps for the command adapter" },
  ),
);
export const DeploymentDiscoverInput = Schema.Struct({
  projectId: Schema.optional(TrimmedNonEmptyString),
  ...Approval,
});
export const DeploymentActionInput = Schema.Struct({
  action: DeploymentAction,
  // adopt only: the exact commit a person says runs, or none for "unknown, accept once".
  commit: Schema.optional(Schema.NullOr(Revision)),
  ...Approval,
}).check(
  Schema.makeFilter((input) => input.action === "adopt" || input.commit === undefined, {
    expected: "a commit only when adopting",
  }),
);

export const DeploymentDependenciesInput = Schema.Struct({
  dependencies: Schema.Array(Identifier),
  ...Approval,
});
