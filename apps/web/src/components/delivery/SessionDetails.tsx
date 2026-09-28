import type { DeliveryThreadBinding, EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState, type ReactNode } from "react";

import { deliveryFailureText, describeBinding } from "../../lib/delivery";
import { deliveryEnvironment, useDeliveryRead, useStaleReading } from "../../state/delivery";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const rows = (value: unknown): ReadonlyArray<Json> =>
  Array.isArray(value) ? value.map(record) : [];
const shown = (value: unknown, fallback = "not reported"): string =>
  typeof value === "string" && value.length > 0
    ? value
    : typeof value === "number"
      ? String(value)
      : fallback;

function Row(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex gap-3 py-0.5">
      <dt className="w-28 shrink-0 text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 flex-1 break-words">{props.children}</dd>
    </div>
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="border-t border-border pt-2 first:border-t-0 first:pt-0">
      <h3 className="pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {props.title}
      </h3>
      <dl>{props.children}</dl>
    </section>
  );
}

const toolState = (tool: Json): string => {
  if (tool.exercised === true) return "exercised";
  if (tool.connected === true) return "connected";
  if (tool.connected === false) return `not connected: ${shown(tool.problem, "no reason given")}`;
  return "configured, not checked yet";
};

/**
 * The expandable details of a session: what it was started with, where it
 * works, which tools it has and how the host is doing. Every reading names
 * its time or says it was not taken.
 */
export function SessionDetails(props: {
  readonly environmentId: EnvironmentId | null;
  readonly binding: DeliveryThreadBinding | null;
  readonly harness: string | null;
  readonly model: string | null;
  readonly cwd: string | null;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly phase: string;
}) {
  const [open, setOpen] = useState(false);
  const described = describeBinding(props.binding);
  const active = open ? props.environmentId : null;
  const session = useDeliveryRead(
    active,
    props.binding ? `/api/sessions/${props.binding.session}` : null,
    { pollMs: 10_000 },
  );
  const host = useDeliveryRead(active, "/api/host", { pollMs: 10_000 });
  const checkTools = useAtomCommand(deliveryEnvironment.act, {
    label: "check team tools",
    reportFailure: false,
  });
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const view = record(session.body);
  const setup = record(view.setup);
  const repository = record(view.repository);
  const hostView = record(host.body);
  const memory = record(hostView.memory);
  const workers = record(hostView.workers);
  const stale = useStaleReading(host.readAt);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={
          described.managed
            ? "max-w-64 cursor-pointer truncate rounded px-1 text-foreground underline decoration-dotted underline-offset-2"
            : "max-w-64 cursor-pointer truncate rounded px-1 underline decoration-dotted underline-offset-2"
        }
        aria-label="Session details"
      >
        {described.label}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="w-[26rem] max-w-[calc(100vw-2rem)]">
        <PopoverTitle className="pb-2 text-sm">Session details</PopoverTitle>
        <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto font-mono text-[11px] leading-relaxed">
          <Section title="Identity">
            <Row label="Status">
              {described.managed ? "Team session, single harness" : "Manual / legacy"}
            </Row>
            {props.binding ? (
              <>
                <Row label="Team">{props.binding.team}</Row>
                <Row label="Role">{props.binding.role}</Row>
                <Row label="Setup">{props.binding.configuration}</Row>
                {setup.behind === true ? (
                  <Row label="Team now">
                    {shown(setup.teamNow)}. This session keeps the setup it started with.
                  </Row>
                ) : null}
                <Row label="Memory scope">{props.binding.memoryScope}</Row>
              </>
            ) : (
              <Row label="Team">None. {described.detail}</Row>
            )}
            <Row label="Harness">{shown(props.harness)}</Row>
            <Row label="Model asked for">{shown(props.binding?.requestedModel ?? props.model)}</Row>
            <Row label="Model used">Not reported by the harness.</Row>
            <Row label="State">{props.phase}</Row>
          </Section>

          <Section title="Repository">
            <Row label="Folder">{shown(props.cwd, "no working folder")}</Row>
            <Row label="Branch">
              {shown(props.branch, "unavailable")}
              {props.dirty ? " (uncommitted changes)" : ""}
            </Row>
            {props.binding ? (
              <>
                <Row label="Repository">{shown(repository.name)}</Row>
                <Row label="Commit">{shown(repository.commit)}</Row>
                <Row label="Worktree">
                  {repository.isWorktree === true ? shown(repository.worktree) : "main checkout"}
                </Row>
                {repository.isEngineRepository === true ? (
                  <Row label="Note">This is the delivery engine's own repository.</Row>
                ) : null}
              </>
            ) : null}
          </Section>

          {props.binding ? (
            <Section title="Tools">
              {rows(view.tools).map((tool) => (
                <Row key={shown(tool.server)} label={shown(tool.server)}>
                  {toolState(tool)}
                  {typeof tool.checked === "string" ? `, checked ${tool.checked}` : ""}
                </Row>
              ))}
              {session.error ? <Row label="Engine">{session.error}</Row> : null}
              <div className="pt-1">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={checking || !props.environmentId}
                  onClick={() => {
                    if (!props.environmentId || !props.binding) return;
                    setChecking(true);
                    setCheckError(null);
                    void checkTools({
                      environmentId: props.environmentId,
                      input: {
                        path: `/api/sessions/${props.binding.session}/tools` as never,
                        body: {},
                      },
                    }).then((result) => {
                      setChecking(false);
                      if (result._tag === "Failure") {
                        setCheckError(deliveryFailureText(squashAtomCommandFailure(result)));
                      }
                      session.refresh();
                    });
                  }}
                >
                  {checking ? "Checking" : "Check tools now"}
                </Button>
                {checkError ? <p className="pt-1 text-warning">{checkError}</p> : null}
              </div>
            </Section>
          ) : null}

          <Section title="Host">
            {host.error ? (
              <Row label="Engine">{host.error}</Row>
            ) : (
              <>
                <Row label="Machine">{shown(hostView.host, "not read yet")}</Row>
                <Row label="Free memory">
                  {typeof memory.freeMb === "number"
                    ? `${memory.freeMb} MB of ${shown(memory.totalMb)} MB`
                    : "not read yet"}
                </Row>
                <Row label="Committed">Not measured.</Row>
                <Row label="Workers">
                  {typeof workers.active === "number"
                    ? `${workers.active} active, ${shown(workers.waiting, "0")} waiting, limit ${shown(workers.limit)}`
                    : "not read yet"}
                </Row>
                <Row label="Read">
                  {host.readAt ? `${host.readAt}${stale ? " (stale)" : ""}` : "not read yet"}
                </Row>
              </>
            )}
          </Section>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
