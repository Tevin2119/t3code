import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Route = Schema.Struct({
  id: Schema.String,
  board: Schema.String,
  repository: Schema.String,
  base: Schema.String,
  project: Schema.String,
  auto_merge: Schema.Number,
});
const Tracking = Schema.Struct({
  request: Schema.NullOr(
    Schema.Struct({ id: Schema.String, origin: Schema.String, task: Schema.String }),
  ),
  complete: Schema.Boolean,
  publications: Schema.Array(
    Schema.Struct({
      pr_url: Schema.NullOr(Schema.String),
      state: Schema.String,
      merge: Schema.NullOr(
        Schema.Struct({
          state: Schema.String,
          problem: Schema.NullOr(Schema.String),
          merge_commit: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
  candidate: Schema.NullOr(Schema.Struct({ state: Schema.String, commit: Schema.String })),
  live: Schema.NullOr(Schema.Struct({ commit: Schema.NullOr(Schema.String) })),
});
const Snapshot = Schema.Struct({
  problem: Schema.optional(Schema.NullOr(Schema.String)),
  boards: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      repository: Schema.NullOr(Schema.String),
      base: Schema.NullOr(Schema.String),
    }),
  ),
  routes: Schema.Array(Route),
  projects: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      repository: Schema.String,
      branch: Schema.String,
      environment: Schema.String,
      mode: Schema.String,
    }),
  ),
  tracking: Schema.Array(Tracking),
});
const decodeSnapshot = Schema.decodeUnknownOption(Snapshot);
export const parseBoardDelivery = (value: unknown) => Option.getOrNull(decodeSnapshot(value));

export function deliveryProgress(row: typeof Tracking.Type): string {
  const merge = row.publications.at(-1)?.merge;
  if (merge?.problem) return merge.problem;
  if (row.complete) return `Live: ${row.live?.commit ?? "revision unavailable"}`;
  if (row.candidate?.state === "live") return `Awaiting live verification: ${row.candidate.commit}`;
  if (row.candidate) return `Release ${row.candidate.state}: ${row.candidate.commit}`;
  if (merge?.state === "merged") return "PR merged; awaiting release qualification";
  if (row.publications.length) return "PR open; awaiting host merge";
  return "Task submitted; awaiting pull request";
}

export function deliveryTaskRequest(
  route: string,
  task: { id: string; origin: string },
  environment: string,
) {
  if (
    !task.origin.startsWith(`thread:${environment}/`) ||
    !task.origin.slice(`thread:${environment}/`.length).trim()
  ) {
    throw new Error("This task needs an originating thread in the selected environment.");
  }
  return { id: `delivery-${task.id}`, route, task: task.id, origin: task.origin };
}
