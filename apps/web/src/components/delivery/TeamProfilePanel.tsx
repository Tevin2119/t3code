import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState, type ReactNode } from "react";

import { parseTeamProfile } from "../../lib/delivery";
import { useDeliveryRead } from "../../state/delivery";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

type Section = "instructions" | "tools" | "specialists" | "rules";

function Block(props: {
  readonly title: string;
  readonly meta?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border">
      <header className="flex items-baseline justify-between gap-2 border-b border-border px-2 py-1">
        <h4 className="text-xs font-medium">{props.title}</h4>
        {props.meta ? (
          <span className="truncate font-mono text-[10px] text-muted-foreground">{props.meta}</span>
        ) : null}
      </header>
      <div className="px-2 py-1.5 text-xs">{props.children}</div>
    </section>
  );
}

/**
 * What a harness in a role of a team is given, read from the engine before
 * any session is opened: the instructions in full and in order, the tools,
 * the specialists, and the rules the team runs by.
 */
export function TeamProfilePanel(props: {
  readonly environmentId: EnvironmentId | null;
  readonly team: string;
  /** The engine's name for the harness, or null to read the team without one. */
  readonly harness: string | null;
  readonly role: string | null;
}) {
  const [section, setSection] = useState<Section>("instructions");
  const query = new URLSearchParams();
  if (props.harness) query.set("harness", props.harness);
  if (props.role) query.set("role", props.role);
  const read = useDeliveryRead(
    props.environmentId,
    `/api/teams/${props.team}/profile${query.size > 0 ? `?${query.toString()}` : ""}`,
  );
  const profile = useMemo(() => parseTeamProfile(read.body), [read.body]);

  if (read.error) {
    return <p className="text-xs text-warning">Delivery engine not reachable. {read.error}</p>;
  }
  if (!profile) return <p className="text-xs text-muted-foreground">Reading the team setup.</p>;

  return (
    <div className="flex flex-col gap-2" data-delivery-team-profile>
      <div className="text-xs">
        <p className="font-medium">
          Team {profile.team}, role {profile.role}
          {profile.harness ? ` on ${profile.harness}` : ""}
        </p>
        <p className="font-mono text-[10px] text-muted-foreground">setup {profile.configuration}</p>
        <p className="text-muted-foreground">{profile.purpose}</p>
        {profile.harness && !profile.heldByASeat ? (
          <p className="text-muted-foreground">
            No seat of the team holds this role on {profile.harness}. The session is a seat of its
            own, chosen by you.
          </p>
        ) : null}
      </div>
      <ToggleGroup
        value={[section]}
        onValueChange={(value) => {
          const next = value[0];
          if (next) setSection(next as Section);
        }}
      >
        <ToggleGroupItem value="instructions">Instructions</ToggleGroupItem>
        <ToggleGroupItem value="tools">Tools</ToggleGroupItem>
        <ToggleGroupItem value="specialists">Specialists</ToggleGroupItem>
        <ToggleGroupItem value="rules">Rules</ToggleGroupItem>
      </ToggleGroup>
      <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
        {section === "instructions"
          ? profile.layers.map((layer, index) => (
              <Block key={layer.name} title={`${index + 1}. ${layer.name}`} meta={layer.source}>
                {layer.text === null ? (
                  <p className="text-muted-foreground">
                    Read by the harness itself from the repository it works in.
                  </p>
                ) : (
                  <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                    {layer.text}
                  </pre>
                )}
              </Block>
            ))
          : null}
        {section === "tools"
          ? profile.tools.map((tool) => (
              <Block key={tool.server} title={tool.server} meta={tool.route}>
                <p className="text-muted-foreground">
                  Runs as {tool.runsAs}
                  {tool.onlyWith ? `. Only for a role with the ${tool.onlyWith} resource` : ""}.
                </p>
                <p className="font-mono text-[11px]">
                  {tool.offers.join(", ") || "no tools listed"}
                </p>
              </Block>
            ))
          : null}
        {section === "tools" && profile.tools.length === 0 ? (
          <p className="text-xs text-muted-foreground">This role has no team tools.</p>
        ) : null}
        {section === "specialists" ? (
          <>
            <p className="text-xs text-muted-foreground">
              {profile.specialists.length === 0
                ? "This team has no specialists."
                : `On call, started by ${profile.specialistsStartedBy ?? "the engine"} when a plan names them.`}
            </p>
            {profile.specialists.map((specialist) => (
              <Block key={specialist.name} title={specialist.name}>
                <pre className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                  {specialist.text}
                </pre>
              </Block>
            ))}
          </>
        ) : null}
        {section === "rules" ? (
          <Block title="How the team works">
            <p>Stages: {profile.stages.join(", ") || "none"}.</p>
            <p>
              QA gate:{" "}
              {profile.qaGate
                ? `${profile.qaGate.seats.join(", ")}; at least ${profile.qaGate.minimum} providers must pass.`
                : "none."}
            </p>
            <p>Memory scope: {profile.memoryScope}.</p>
            <p className="text-muted-foreground">
              A single chat in this team is one harness with the team's setup. It runs no stages and
              no QA gate: those belong to a workflow started through the Orchestrator.
            </p>
          </Block>
        ) : null}
      </div>
    </div>
  );
}
