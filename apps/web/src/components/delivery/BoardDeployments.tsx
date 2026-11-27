import { useAtomValue } from "@effect/atom-react";
import type { DeploymentProject, EnvironmentId } from "@t3tools/contracts";
import { PlusIcon, RefreshCwIcon, ServerIcon } from "lucide-react";
import { useState } from "react";
import type { DeliveryTarget } from "../../lib/delivery";
import { parseDeployments } from "../../lib/deployments";
import { deliveryEnvironment, useDeliveryRead, useStaleReading } from "../../state/delivery";
import { Button } from "../ui/button";
import { DeploymentApproval, type DeploymentRequest } from "./DeploymentInstance";
import { Configuration } from "./DeploymentsPage";
import { ReleaseLines } from "./ReleaseLine";

/**
 * The board repository's release line, with the same cards and actions as Deployments.
 * Read only while the board's settings are open; the engine narrows it to the repository.
 */
export function BoardDeployments(props: {
  environmentId: EnvironmentId;
  target: DeliveryTarget | null;
}) {
  const repository = props.target?.repository ?? null;
  const read = useDeliveryRead(
    repository ? props.environmentId : null,
    repository ? `/api/deployments?repository=${encodeURIComponent(repository)}` : null,
    { pollMs: 10_000 },
  );
  const snapshot = parseDeployments(read.body);
  const stale = useStaleReading(read.readAt);
  const allowed = useAtomValue(deliveryEnvironment.act.permissionAtom(props.environmentId));
  const [configuration, setConfiguration] = useState<{ project: DeploymentProject | null } | null>(
    null,
  );
  const [request, setRequest] = useState<DeploymentRequest | null>(null);
  // An engine without the repository filter lists every project; only this repository's show.
  const projects = snapshot?.projects.filter((project) => project.repository === repository) ?? [];
  const unavailable = stale || !!read.error || !!snapshot?.problem;
  const disabled = !allowed || unavailable || !snapshot;
  return (
    <section className="min-w-0 space-y-3" aria-label="Board deployments">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex flex-1 items-center gap-2 text-sm font-medium">
          <ServerIcon aria-hidden="true" className="size-4" />
          Deployments
        </h3>
        <Button size="sm" variant="ghost" disabled={!repository} onClick={read.refresh}>
          <RefreshCwIcon aria-hidden="true" />
          Refresh
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !repository}
          onClick={() => setConfiguration({ project: null })}
        >
          <PlusIcon aria-hidden="true" />
          Add instance…
        </Button>
      </div>
      {!repository ? (
        <p className="text-xs text-muted-foreground">This board has no repository yet.</p>
      ) : read.error ? (
        <p role="alert" className="break-words text-xs text-warning-foreground">
          Could not read deployments. {read.error}
        </p>
      ) : read.isPending && !snapshot ? (
        <p className="text-xs text-muted-foreground">Reading deployments…</p>
      ) : !snapshot ? (
        <p role="alert" className="text-xs text-warning-foreground">
          This engine returned an unsupported deployment response.
        </p>
      ) : projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No deployment instance for {props.target?.title ?? repository} yet.
        </p>
      ) : null}
      {snapshot?.problem ? (
        <p role="alert" className="break-words text-xs text-warning-foreground">
          {snapshot.problem}
        </p>
      ) : null}
      {stale && snapshot ? (
        <p role="status" className="text-xs text-warning-foreground">
          This reading is stale. Refresh before changing deployments.
        </p>
      ) : null}
      {snapshot ? (
        <div className="flex min-w-0 flex-col gap-4">
          <ReleaseLines
            environmentId={props.environmentId}
            snapshot={snapshot}
            projects={projects}
            unavailable={unavailable}
            disabled={disabled}
            onRequest={setRequest}
            onConfigure={(project) => setConfiguration({ project })}
          />
        </div>
      ) : null}
      {configuration && snapshot ? (
        <Configuration
          environmentId={props.environmentId}
          snapshot={snapshot}
          project={configuration.project}
          initialRepository={repository}
          onClose={() => setConfiguration(null)}
          onRegistered={read.refresh}
          onSave={(body) => {
            setConfiguration(null);
            setRequest({
              title: "Save deployment settings",
              path: "/api/deployments/projects",
              body,
            });
          }}
        />
      ) : null}
      {request ? (
        <DeploymentApproval
          environmentId={props.environmentId}
          request={request}
          unavailable={unavailable || !snapshot}
          onClose={() => setRequest(null)}
          onDone={() => {
            setRequest(null);
            read.refresh();
          }}
        />
      ) : null}
    </section>
  );
}
