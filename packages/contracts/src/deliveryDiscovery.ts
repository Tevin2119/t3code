import * as Schema from "effect/Schema";
import { EnvironmentId } from "./baseSchemas.ts";

const Text = Schema.String.check(Schema.isMaxLength(256));
const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/));
const Branch = Schema.String.check(Schema.isMaxLength(256));
const list = <S extends Schema.Top>(item: S) => Schema.Array(item).check(Schema.isMaxLength(12));

export const DeliveryDiscoveryInput = Schema.Struct({
  folder: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  board: Schema.optional(Id),
  route: Schema.optional(Id),
  team: Schema.optional(Id),
  task: Schema.optional(Id),
  fresh: Schema.optional(Schema.Boolean),
  preflight: Schema.optional(Schema.Boolean),
});
export type DeliveryDiscoveryInput = typeof DeliveryDiscoveryInput.Type;

export const DeliveryDiscoveryDiagnostic = Schema.Literals([
  "disabled",
  "unsupported-server",
  "unsupported-provider-tools",
  "unreachable",
  "profile-mismatch",
  "environment-mismatch",
  "unauthorized",
  "remote-unpaired",
  "unregistered-repository",
  "ambiguous-board",
  "ambiguous-deployment",
  "missing-target",
  "missing-team",
  "missing-deployment",
  "task-not-found",
  "configuration-changed",
  "response-too-large",
  "invalid-request",
]);
export type DeliveryDiscoveryDiagnostic = typeof DeliveryDiscoveryDiagnostic.Type;

const Task = Schema.Struct({ id: Text, state: Text, branch: Schema.NullOr(Branch) });
export const DeliveryDiscoverySnapshot = Schema.Struct({
  environmentId: EnvironmentId,
  profile: Schema.NullOr(Text),
  configuration: Text,
  checkedAt: Text,
  readAt: Schema.NullOr(Text),
  expiresAt: Schema.NullOr(Text),
  diagnostics: Schema.Array(DeliveryDiscoveryDiagnostic).check(Schema.isMaxLength(19)),
  preflight: Schema.Literals(["not-requested", "ready", "blocked"]),
  repository: Schema.NullOr(
    Schema.Struct({ id: Text, root: Schema.String.check(Schema.isMaxLength(1024)) }),
  ),
  provider: Schema.Struct({
    driver: Schema.NullOr(Text),
    tools: Schema.NullOr(Schema.Boolean),
    teamHarness: Schema.NullOr(Text),
  }),
  boards: list(Schema.Struct({ id: Text, branch: Schema.NullOr(Branch) })),
  teams: list(
    Schema.Struct({
      id: Text,
      available: Schema.Boolean,
      takesTasks: Schema.Boolean,
      harnesses: list(Text),
      tools: list(Text),
    }),
  ),
  deployments: list(
    Schema.Struct({
      id: Text,
      branch: Branch,
      environment: Text,
      mode: Text,
      liveCommit: Schema.NullOr(Text),
      liveObservedAt: Schema.NullOr(Text),
      liveHealthy: Schema.NullOr(Schema.Boolean),
    }),
  ),
  boardDeployment: Schema.Struct({
    capability: Schema.Literals(["available", "unsupported", "unavailable", "not-selected"]),
    board: Schema.NullOr(Text),
    projectId: Schema.NullOr(Text),
    state: Schema.NullOr(Schema.Literals(["unlinked", "linked", "invalid"])),
  }),
  routes: list(
    Schema.Struct({
      id: Text,
      board: Text,
      project: Text,
      branch: Branch,
      autoMerge: Schema.Boolean,
      valid: Schema.Boolean,
      updatedAt: Schema.NullOr(Text),
    }),
  ),
  linkedTasks: list(Schema.Struct({ ...Task.fields, requestId: Text, origin: Text })),
  task: Schema.NullOr(Task),
  truncated: Schema.Boolean,
});
export type DeliveryDiscoverySnapshot = typeof DeliveryDiscoverySnapshot.Type;
