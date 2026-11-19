import { useAtomValue } from "@effect/atom-react";
import type { BoardDeploymentLink, EnvironmentId } from "@t3tools/contracts";
import { LinkIcon, RocketIcon, UnlinkIcon } from "lucide-react";
import { useState } from "react";
import { parseDeployments, parseDeploymentCommands } from "../../lib/deployments";
import type { DeliveryTarget } from "../../lib/delivery";
import { deliveryEnvironment, useDeliveryRead, useStaleReading } from "../../state/delivery";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { BoardDeliveryApproval } from "./BoardDeliveryApproval";

export function BoardDeploymentControls(props: {
  environmentId: EnvironmentId;
  board: string;
  target: DeliveryTarget | null;
  link: BoardDeploymentLink | null | undefined;
  stale: boolean;
  onDone: () => void;
}) {
  const allowed = useAtomValue(deliveryEnvironment.act.permissionAtom(props.environmentId));
  const [editing, setEditing] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const path = `/api/boards/${props.board}/deployment`;
  const linked = props.link?.deploymentProjectId;
  return (
    <section className="min-w-0 space-y-2" aria-label="Board deployment link">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <RocketIcon className="size-4" />
        Deployment link
      </h3>
      <p className="break-words text-xs text-muted-foreground">
        {props.link
          ? linked
            ? `${props.link.state}: ${props.link.project?.title ?? linked} · ${props.link.project?.environment ?? "unknown environment"} · ${props.link.project?.branch ?? "unknown branch"} · ${props.link.project?.mode ?? "unknown mode"}`
            : "Not linked. Existing publications keep their original attribution."
          : "Deployment link status is unavailable from this engine."}
      </p>
      {linked ? (
        <p className="break-all font-mono text-2xs text-muted-foreground">{linked}</p>
      ) : null}
      {props.link?.problem ? (
        <p className="text-xs text-warning-foreground">{props.link.problem}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={
            !allowed ||
            !props.link ||
            props.stale ||
            !props.target?.repository ||
            !props.target.base ||
            !props.target.ok
          }
          onClick={() => setEditing(true)}
        >
          <LinkIcon />
          {linked ? "Relink…" : "Link deployment…"}
        </Button>
        {linked ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!allowed || props.stale}
            onClick={() => setUnlinking(true)}
          >
            <UnlinkIcon />
            Unlink…
          </Button>
        ) : null}
      </div>
      {editing && props.target ? (
        <LinkEditor
          environmentId={props.environmentId}
          target={props.target}
          stale={props.stale || !props.link}
          path={path}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            props.onDone();
          }}
        />
      ) : null}
      {unlinking ? (
        <BoardDeliveryApproval
          environmentId={props.environmentId}
          title="Unlink deployment"
          unavailable={props.stale || !props.link}
          description="Future publications will not inherit a deployment project from this board. Existing publication environments, runs and history remain unchanged."
          path={path}
          body={{ deploymentProjectId: null }}
          onClose={() => setUnlinking(false)}
          onDone={() => {
            setUnlinking(false);
            props.onDone();
          }}
        />
      ) : null}
    </section>
  );
}

function LinkEditor(props: {
  stale: boolean;
  environmentId: EnvironmentId;
  target: DeliveryTarget;
  path: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const read = useDeliveryRead(props.environmentId, "/api/deployments");
  const snapshot = read.error ? null : parseDeployments(read.body);
  const stale = useStaleReading(read.readAt);
  const unavailable = props.stale || stale || !snapshot || !!snapshot.problem || !props.target.ok;
  const [choice, setChoice] = useState("");
  const [environment, setEnvironment] = useState("");
  const [customEnvironment, setCustomEnvironment] = useState("");
  const [commands, setCommands] = useState("");
  const [signing, setSigning] = useState<{
    title: string;
    description: string;
    body: Record<string, unknown>;
  } | null>(null);
  const creating = choice === "new";
  const project = snapshot?.projects.find((item) => item.id === choice);
  const parsed = parseDeploymentCommands(commands);
  const releaseEnvironment =
    environment === "__new_environment__" ? customEnvironment.trim() : environment;
  const environments = [
    ...new Set([
      "production",
      "staging",
      "development",
      ...(snapshot?.projects.map((item) => item.environment) ?? []),
    ]),
  ];
  const valid =
    !unavailable &&
    snapshot &&
    !snapshot.problem &&
    (creating
      ? !!props.target.repository &&
        !!props.target.base &&
        /^[a-z0-9][a-z0-9._-]{0,39}$/.test(releaseEnvironment) &&
        !!parsed.commands
      : !!project && project.branch === props.target.base);
  const body = creating
    ? {
        create: {
          repository: props.target.repository,
          branch: props.target.base,
          environment: releaseEnvironment,
          adapter: "command",
          commands: parsed.commands,
        },
      }
    : { deploymentProjectId: choice };
  if (signing)
    return (
      <BoardDeliveryApproval
        environmentId={props.environmentId}
        title={signing.title}
        unavailable={unavailable || !valid}
        description={signing.description}
        path={props.path}
        body={signing.body}
        onClose={() => setSigning(null)}
        onDone={props.onDone}
      />
    );
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Board deployment link</DialogTitle>
          <DialogDescription>
            Choose an explicit repository + release environment project. The watch branch must match{" "}
            {props.target.base}. Linking never changes a project's mode or rewrites publication
            history.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex min-w-0 flex-col gap-4">
            <p className="break-words text-xs text-muted-foreground">
              Board target: {props.target.title ?? props.target.repository} · {props.target.base}
            </p>
            <Select value={choice} onValueChange={(value) => setChoice(value ?? "")}>
              <SelectTrigger aria-label="Deployment project">
                <SelectValue placeholder="Choose a deployment project">
                  {creating
                    ? "Create a new project and link…"
                    : project
                      ? `${project.title} · ${project.environment} · ${project.branch}`
                      : undefined}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {(snapshot?.projects ?? []).map((item) => (
                  <SelectItem
                    key={item.id}
                    value={item.id}
                    disabled={item.branch !== props.target.base}
                  >
                    <span className="block max-w-64 break-words">
                      {item.title} · {item.environment} · {item.branch} · {item.mode}
                    </span>
                    <span className="block max-w-64 break-all text-2xs text-muted-foreground">
                      {item.repository} · {item.id}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value="new">Create a new project and link…</SelectItem>
              </SelectPopup>
            </Select>
            {!creating ? (
              <p className="text-xs text-muted-foreground">
                Repository aliases are validated by the engine's canonical folder identity, not by
                their display names. No project is selected automatically.
              </p>
            ) : (
              <>
                <Select
                  value={environment}
                  onValueChange={(value) => value && setEnvironment(value)}
                >
                  <SelectTrigger aria-label="Release environment">
                    <SelectValue placeholder="Choose a release environment" />
                  </SelectTrigger>
                  <SelectPopup>
                    {environments.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                    <SelectItem value="__new_environment__">New environment…</SelectItem>
                  </SelectPopup>
                </Select>
                {environment === "__new_environment__" ? (
                  <Input
                    aria-label="New release environment"
                    value={customEnvironment}
                    onChange={(event) => setCustomEnvironment(event.target.value)}
                    placeholder="e.g. preview"
                  />
                ) : null}
                <p className="text-xs text-muted-foreground">
                  New projects use Repository commands and auto-qualify. Deployment remains manual.
                  Existing projects must be linked by ID; creation never reconfigures them.
                </p>
                <Textarea
                  aria-label="Repository deployment commands"
                  value={commands}
                  onChange={(event) => setCommands(event.target.value)}
                  placeholder={'{"qualify":["check"],"deploy":["ship"],"verify":["health"]}'}
                  rows={5}
                />
                <p className="text-xs text-muted-foreground">
                  JSON argument arrays: qualify, deploy and verify; optional setup. Never include
                  secrets. Use Deployments for advanced adapter or mode configuration.
                </p>
                {parsed.problem ? (
                  <p role="alert" className="text-xs text-warning-foreground">
                    {parsed.problem}
                  </p>
                ) : null}
              </>
            )}
            {read.error || snapshot?.problem ? (
              <p role="alert" className="text-sm text-warning-foreground">
                {read.error ?? snapshot?.problem}
              </p>
            ) : !snapshot ? (
              <p className="text-xs text-muted-foreground">
                {read.isPending
                  ? "Loading deployment projects…"
                  : "Deployment projects are unavailable."}
              </p>
            ) : null}
            <Button variant="ghost" size="sm" onClick={read.refresh}>
              Refresh projects
            </Button>
            {props.stale || stale ? (
              <p role="alert" className="text-sm text-warning-foreground">
                Snapshot is stale. Refresh the board and projects before reviewing a link.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid}
            onClick={() =>
              setSigning({
                title: creating ? "Create and link deployment" : "Link deployment",
                description: creating
                  ? `Create ${props.target.title ?? props.target.repository} · ${releaseEnvironment} · ${props.target.base} in auto-qualify mode. Deployment stays manual. If the response fails, inspect Deployments before retrying: the project may exist even if linking failed.`
                  : `Link ${project?.title} · ${project?.environment} (${choice}). Its saved mode stays ${project?.mode}. The engine validates the canonical repository and watch branch; it never substitutes a different project.`,
                body,
              })
            }
          >
            Review link…
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
