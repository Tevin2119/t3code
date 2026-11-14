import type { EnvironmentId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { DeliveryRepository } from "../../lib/delivery";
import { useDeliveryAct } from "../../state/delivery";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Where T3 says a folder's work is pushed: the remote and the GitHub repository behind it. */
export function publishTargetOf(
  projects: ReadonlyArray<EnvironmentProject>,
  environmentId: EnvironmentId | null | undefined,
  folder: string,
): { readonly remote: string; readonly repository: string } | null {
  const wanted = normalizeProjectPathForComparison(folder);
  const identity = projects.find(
    (project) =>
      project.environmentId === environmentId &&
      normalizeProjectPathForComparison(project.workspaceRoot) === wanted,
  )?.repositoryIdentity;
  if (!identity || identity.provider !== "github" || !identity.owner || !identity.name) return null;
  return {
    remote: identity.locator.remoteName,
    repository: `${identity.owner}/${identity.name}`,
  };
}

const problemsOf = (body: unknown): ReadonlyArray<string> => {
  const ready = (body as { ready?: { problems?: unknown } } | null)?.ready;
  return Array.isArray(ready?.problems)
    ? ready.problems.filter((item): item is string => typeof item === "string")
    : [];
};

const OPTIONS = [
  {
    mode: "publish",
    title: "Pushed for review",
    detail: "The approved commit is pushed to a branch of its own and one pull request is opened.",
  },
  {
    mode: "local",
    title: "Kept on a branch",
    detail: "The approved commit stays on a branch of the clone. Nothing is pushed.",
  },
] as const;

/**
 * Where a repository's approved work goes. The engine starts no task in a repository that has
 * not said, so the board that binds to it asks here.
 */
export function RepositoryDelivery(props: {
  readonly environmentId: EnvironmentId | null;
  readonly repository: DeliveryRepository;
  /** The branch pull requests are opened against. */
  readonly base: string;
  /** What T3 knows of the folder's remote, offered so it need not be typed. */
  readonly suggested: { readonly remote: string; readonly repository: string } | null;
  readonly by?: string | undefined;
}) {
  const act = useDeliveryAct(props.environmentId, "set repository delivery");
  const mode = props.repository.delivery?.mode ?? null;
  const remote = props.repository.delivery?.remote ?? props.suggested?.remote ?? "origin";
  const [asking, setAsking] = useState(false);
  const [slug, setSlug] = useState(props.suggested?.repository ?? "");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);

  const save = async (delivery: Record<string, string>) => {
    setBusy(true);
    setProblems([]);
    const result = await act(`/api/repositories/${props.repository.id}/delivery`, {
      delivery,
      by: props.by,
    });
    setBusy(false);
    if (!result.ok) {
      setProblems(result.problems.length > 0 ? result.problems : [result.why]);
      return;
    }
    setAsking(false);
    setProblems(problemsOf(result.body));
  };

  return (
    <div className="flex flex-col gap-1" data-repository-delivery={mode ?? "unset"}>
      <span className="text-xs font-medium">Approved work</span>
      <div className="grid gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="Approved work">
        {OPTIONS.map((option) => {
          const chosen = asking ? option.mode === "publish" : option.mode === mode;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={chosen}
              disabled={busy}
              data-repository-delivery-option={option.mode}
              onClick={() => {
                if (option.mode === "publish") setAsking(true);
                else void save({ mode: "local" });
              }}
              className={cn(
                "flex cursor-pointer flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                chosen ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
              )}
            >
              <span className="font-medium">{option.title}</span>
              <span className="text-2xs text-muted-foreground">{option.detail}</span>
            </button>
          );
        })}
      </div>
      {asking ? (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void save({
              mode: "publish",
              remote,
              base: props.base,
              host: "github",
              repository: slug.trim(),
            });
          }}
        >
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <Input
                size="sm"
                aria-label="GitHub repository pull requests are opened in"
                placeholder="owner/name"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
              />
            </div>
            <Button type="submit" size="sm" disabled={busy || !slug.trim() || !props.base}>
              Use
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
          <span className="text-2xs text-muted-foreground">
            Pull requests are opened in this GitHub repository, pushed through the {remote} remote,
            into {props.base || "the base branch chosen above"}. Name your fork here if the work
            should not go to the repository it was forked from.
          </span>
        </form>
      ) : mode === null ? (
        <p className="text-xs text-warning" data-repository-delivery-unset>
          Choose one. No task on this board starts until {props.repository.title} says where its
          approved work goes.
        </p>
      ) : mode === "publish" ? (
        <span className="text-2xs text-muted-foreground">
          Pushed through the {remote} remote. Choose "Pushed for review" again to change where.
        </span>
      ) : null}
      {problems.map((problem) => (
        <p key={problem} role="alert" className="text-xs text-warning">
          {problem}
        </p>
      ))}
    </div>
  );
}
