import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DeploymentAdapter, DeploymentCommands, DeploymentMode } from "./deployments.ts";

const NullableText = Schema.NullOr(Schema.String);
const Approval = { by: TrimmedNonEmptyString, key: Schema.String.check(Schema.isMinLength(1)) };
export const MergePermissionSetting = Schema.Literals(["on", "off", "inherit"]);
export const MergePermissionInput = Schema.Struct({
  mergePermission: MergePermissionSetting,
  ...Approval,
  confirmed: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((input) => input.mergePermission !== "on" || input.confirmed === true, {
    expected: "explicit confirmation to enable automatic merge permission",
  }),
);
export const MergePermissionView = Schema.Struct({
  setting: MergePermissionSetting,
  requestedBy: NullableText,
  requestedSince: NullableText,
  resolved: Schema.Literals(["on", "off"]),
  eligible: Schema.Boolean,
  source: Schema.Literals(["task", "ancestor", "board", "global", "fallback", "problem"]),
  sourceId: NullableText,
  by: NullableText,
  since: NullableText,
  board: NullableText,
  mode: Schema.String,
  problem: NullableText,
  blockingReason: NullableText,
  execution: Schema.Literals(["guarded", "not-implemented"]),
});
export type MergePermissionView = typeof MergePermissionView.Type;

export const BoardDeploymentInput = Schema.Union([
  Schema.Struct({ deploymentProjectId: Schema.NullOr(TrimmedNonEmptyString), ...Approval }),
  Schema.Struct({
    create: Schema.Struct({
      repository: TrimmedNonEmptyString,
      branch: TrimmedNonEmptyString,
      environment: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,39}$/)),
      adapter: DeploymentAdapter,
      commands: Schema.optional(DeploymentCommands),
      // Only a new board-linked project defaults to auto-qualify; a link never changes mode.
      mode: Schema.optional(DeploymentMode),
    }).check(
      Schema.makeFilter(
        (input) => input.adapter !== "engine" || input.environment === "production",
        {
          expected: "production for the built-in engine adapter",
        },
      ),
    ),
    ...Approval,
    confirmed: Schema.optional(Schema.Boolean),
  }).check(
    Schema.makeFilter((input) => input.create.mode !== "full-auto" || input.confirmed === true, {
      expected: "explicit consent for full-auto deployment",
    }),
  ),
]);

const LinkedProject = Schema.Struct({
  id: Schema.String,
  repository: Schema.String,
  path: Schema.String,
  environment: Schema.String,
  branch: Schema.String,
  mode: Schema.String,
  title: Schema.String,
});
export const BoardDeploymentLink = Schema.Struct({
  deploymentProjectId: NullableText,
  state: Schema.Literals(["unlinked", "linked", "invalid"]),
  problem: NullableText,
  by: NullableText,
  at: NullableText,
  project: Schema.NullOr(LinkedProject),
});
export type BoardDeploymentLink = typeof BoardDeploymentLink.Type;

const TaskDeploymentCandidate = Schema.Struct({
  id: Schema.String,
  commit: Schema.String,
  branch: Schema.String,
  state: Schema.String,
  inclusion: NullableText,
  evidence: Schema.Unknown,
  problem: NullableText,
  failedPhase: NullableText,
  liveAt: NullableText,
  liveUntil: NullableText,
});
const Outcome = {
  state: Schema.String,
  problem: NullableText,
  candidate: Schema.NullOr(TaskDeploymentCandidate),
};
export const TaskDeploymentPublication = Schema.Struct({
  publication: Schema.String,
  run: Schema.String,
  task: Schema.String,
  board: Schema.String,
  projectId: Schema.String,
  repositoryPath: NullableText,
  targetBranch: NullableText,
  project: Schema.NullOr(LinkedProject),
  headCommit: NullableText,
  pullRequest: Schema.Struct({ number: Schema.Number, url: Schema.String }),
  publicationState: Schema.String,
  mergeCommit: NullableText,
  ...Outcome,
  history: Schema.Array(Schema.Struct({ ...Outcome, at: Schema.String })),
  updated: Schema.String,
});
export type TaskDeploymentPublication = typeof TaskDeploymentPublication.Type;
export const TaskDeployment = Schema.Struct({
  current: TaskDeploymentPublication,
  history: Schema.Array(TaskDeploymentPublication),
});
export type TaskDeployment = typeof TaskDeployment.Type;
