import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  parseSeatSetup,
  TOOL_STATE_LABEL,
  type SeatChoice,
  type SeatSetup,
  type ToolState,
} from "../../lib/delivery";
import { harnessLabel } from "../../lib/deliverySeats";
import { cn } from "../../lib/utils";
import { useDeliveryAct } from "../../state/delivery";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

type Section = "instructions" | "tools" | "specialists" | "seats";

const TOOL_TONE: Record<ToolState, "success" | "warning" | "error" | "secondary" | "outline"> = {
  working: "success",
  incomplete: "warning",
  failed: "error",
  "not-checked": "outline",
  "not-reachable": "secondary",
  "not-for-this-seat": "secondary",
};

const SPECIALIST_KIND: Record<string, string> = {
  agent: "Agent, started by the engine",
  subagent: "Subagent of the harness",
  prompt: "Prompt only",
};

function Block(props: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly children: ReactNode;
  readonly name?: string;
}) {
  return (
    <section className="rounded-md border border-border" data-setup-block={props.name}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
        <h4 className="min-w-0 truncate text-xs font-medium">{props.title}</h4>
        {props.meta ? (
          <span className="min-w-0 shrink truncate font-mono text-[10px] text-muted-foreground">
            {props.meta}
          </span>
        ) : null}
      </header>
      <div className="flex flex-col gap-1 px-2 py-1.5 text-xs">{props.children}</div>
    </section>
  );
}

/**
 * What one seat of a team is really given, and what of it really works: the
 * instructions in the order they are given and where each comes from, the
 * tools with what was seen of them, and the specialists as what they are.
 * A tool is shown as working only after it was started and answered.
 */
export function SetupPanel(props: {
  readonly environmentId: EnvironmentId | null;
  readonly team: string;
  /** The seat to look at. Null is the seat that leads the flow. */
  readonly seat?: string | null;
  readonly flow?: string | null;
  /** The seat choices of a draft, to see the setup they would give. */
  readonly seats?: Readonly<Record<string, SeatChoice>>;
}) {
  const act = useDeliveryAct(props.environmentId, "team setup");
  const [section, setSection] = useState<Section>("instructions");
  const [seat, setSeat] = useState<string | null>(props.seat ?? null);
  const [setup, setSetup] = useState<SeatSetup | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const asked = useRef(0);
  const seats = JSON.stringify(props.seats ?? {});

  const read = useCallback(
    async (check: boolean) => {
      asked.current += 1;
      const mine = asked.current;
      if (check) setChecking(true);
      const result = await act(`/api/teams/${props.team}/setup${check ? "/check" : ""}`, {
        seat,
        flow: props.flow ?? null,
        seats: JSON.parse(seats) as Record<string, SeatChoice>,
      });
      if (check) setChecking(false);
      // An answer to an earlier asking is not shown over a later one.
      if (mine !== asked.current) return;
      if (!result.ok) {
        setProblem(result.why);
        return;
      }
      setProblem(null);
      setSetup(parseSeatSetup(result.body));
    },
    [act, props.flow, props.team, seat, seats],
  );
  useEffect(() => {
    void read(false);
  }, [read]);

  if (problem && !setup) {
    return (
      <p className="text-xs text-warning" data-delivery-problem>
        {problem}
      </p>
    );
  }
  if (!setup) return <p className="text-xs text-muted-foreground">Reading the setup.</p>;
  const mine = setup.tools.filter((tool) => tool.forThisSeat);
  const unchecked = mine.filter((tool) => tool.state === "not-checked").length;

  return (
    <div className="flex min-h-0 flex-col gap-2" data-delivery-setup={setup.team}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-medium">{setup.team}</span>
        <Badge size="sm" variant="outline">
          {setup.source === "custom" ? "your profile" : "comes with the engine"}
        </Badge>
        <span className="font-mono text-[10px] text-muted-foreground">{setup.configuration}</span>
        <Select value={setup.seat.seat} onValueChange={(value) => setSeat(String(value))}>
          <SelectTrigger
            aria-label="Seat to look at"
            size="compact"
            variant="ghost"
            className="ml-auto w-auto min-w-0"
          >
            <SelectValue>
              {setup.seat.title}, {harnessLabel(setup.seat.harness)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {setup.seats.map((item) => (
              <SelectItem key={item.seat} value={item.seat}>
                <span className="flex flex-col">
                  <span>
                    {item.title}
                    {item.on ? "" : " (switched off)"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {harnessLabel(item.harness)}, {item.model ?? "its own model"}
                    {item.installed ? "" : ". Not installed on this host"}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <p className="text-[11px] text-muted-foreground" data-setup-seat>
        {setup.seat.title} runs on {harnessLabel(setup.seat.harness)},{" "}
        {setup.seat.model ?? "its own model"}
        {setup.seat.reasoning ? `, ${setup.seat.reasoning} reasoning` : ""}, {setup.seat.access}{" "}
        access. {setup.seat.on ? "It is switched on." : "It is switched off, and is asked nothing."}
        {setup.seat.installed
          ? ""
          : ` ${harnessLabel(setup.seat.harness)} is not installed on this host.`}
      </p>
      {setup.problems.length > 0 ? (
        <ul className="list-disc pl-5 text-[11px] text-warning" data-setup-problems>
          {setup.problems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {problem ? <p className="text-xs text-warning">{problem}</p> : null}

      <ToggleGroup
        value={[section]}
        onValueChange={(value) => {
          const next = value[0];
          if (next) setSection(next as Section);
        }}
      >
        <ToggleGroupItem value="instructions">Instructions</ToggleGroupItem>
        <ToggleGroupItem value="tools">
          Tools
          {mine.length > 0
            ? ` (${mine.filter((tool) => tool.state === "working").length}/${mine.length})`
            : ""}
        </ToggleGroupItem>
        <ToggleGroupItem value="specialists">
          Specialists ({setup.specialists.length})
        </ToggleGroupItem>
        <ToggleGroupItem value="seats">
          Seats ({setup.seats.filter((item) => item.on).length}/{setup.seats.length})
        </ToggleGroupItem>
      </ToggleGroup>

      <div className="flex max-h-[50vh] min-h-0 flex-col gap-2 overflow-y-auto">
        {section === "instructions" ? (
          <>
            <p className="text-[11px] text-muted-foreground">
              Given in this order. What comes later is read with what came before it in mind.
              {setup.memoryScope === "profile"
                ? " This profile keeps notes, which every conversation of it is given."
                : " Each conversation stands by itself: nothing of another is given."}
            </p>
            {setup.instructions.map((layer, index) => (
              <Block
                key={`${layer.name}:${layer.source}`}
                name={layer.name}
                title={`${index + 1}. ${layer.name}`}
                meta={layer.file ?? layer.source}
              >
                {layer.text === null ? (
                  <p className="text-muted-foreground">{layer.note}</p>
                ) : (
                  <pre className="max-h-64 overflow-y-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                    {layer.text}
                  </pre>
                )}
              </Block>
            ))}
          </>
        ) : null}

        {section === "tools" ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">
                {unchecked > 0
                  ? "That a tool is configured does not show that it works. Check to have each server started as this seat would be given it."
                  : "Each server was started as this seat is given it, and asked for its tools."}
              </p>
              <Button
                size="xs"
                variant="outline"
                disabled={checking || mine.length === 0}
                onClick={() => void read(true)}
                data-setup-check
              >
                {checking ? <Spinner className="size-3" /> : null}
                {checking ? "Checking" : "Check the tools now"}
              </Button>
            </div>
            {setup.tools.length === 0 ? (
              <p className="text-xs text-muted-foreground">This team has no tools.</p>
            ) : null}
            {setup.tools.map((tool) => (
              <Block
                key={tool.server}
                name={tool.server}
                title={
                  <span className="flex items-center gap-1.5">
                    {tool.server}
                    <Badge size="sm" variant={TOOL_TONE[tool.state]} data-tool-state={tool.state}>
                      {TOOL_STATE_LABEL[tool.state]}
                    </Badge>
                  </span>
                }
                meta={tool.forThisSeat ? tool.route : null}
              >
                <p className="text-muted-foreground">Runs as {tool.runsAs}.</p>
                {tool.whyNotForThisSeat ? <p>{tool.whyNotForThisSeat}.</p> : null}
                {tool.forThisSeat && tool.whyNotReachable ? <p>{tool.whyNotReachable}.</p> : null}
                {tool.checked ? (
                  <>
                    {tool.checked.problem ? (
                      <p className="text-warning">{tool.checked.problem}</p>
                    ) : null}
                    {tool.checked.tools.length > 0 ? (
                      <ul className="flex flex-col gap-0.5" data-tool-list>
                        {tool.checked.tools.map((item) => (
                          <li key={item.name}>
                            <span className="font-mono text-[11px]">{item.name}</span>
                            {item.description ? (
                              <span className="text-muted-foreground"> {item.description}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="text-[10px] text-muted-foreground">
                      Checked {tool.checked.at}.{" "}
                      {tool.checked.connected
                        ? `It listed ${tool.checked.tools.length} tools${tool.checked.exercised ? ", and answered for this team and seat" : ""}.`
                        : "It did not start."}
                    </p>
                  </>
                ) : tool.forThisSeat ? (
                  <p className="text-muted-foreground">
                    {tool.checkedBefore
                      ? `It was checked at ${tool.checkedBefore.at}, and ${tool.checkedBefore.why}. That check does not count for this setup.`
                      : "Not checked yet."}{" "}
                    The team's definition says it offers:{" "}
                    <span className="font-mono text-[11px]">
                      {tool.declared.join(", ") || "nothing it names"}
                    </span>
                    . That is what is written down, not what was seen.
                  </p>
                ) : null}
              </Block>
            ))}
          </>
        ) : null}

        {section === "specialists" ? (
          <>
            {setup.specialists.length === 0 ? (
              <p className="text-xs text-muted-foreground">This team has no specialists.</p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                A specialist may be an agent the engine starts, a subagent the harness starts by
                itself, or only words. Which it is depends on the team and on the harness of the
                seat.
              </p>
            )}
            {setup.specialists.map((item) => (
              <Block
                key={item.name}
                name={item.name}
                title={
                  <span className="flex items-center gap-1.5">
                    {item.name}
                    <Badge
                      size="sm"
                      variant={item.kind === "prompt" ? "outline" : "secondary"}
                      data-specialist-kind={item.kind}
                    >
                      {SPECIALIST_KIND[item.kind] ?? item.kind}
                    </Badge>
                  </span>
                }
                meta={item.file}
              >
                <p>{item.purpose}</p>
                <p className="text-muted-foreground">{item.how}</p>
                {item.alsoInSessions && item.kind === "agent" ? (
                  <p className="text-muted-foreground">{item.alsoInSessions}</p>
                ) : null}
                {item.host ? (
                  <p className="text-muted-foreground">
                    Runs on {harnessLabel(item.host.harness)}, {item.host.model ?? "its own model"},
                    with the tools of {item.host.seat}:{" "}
                    <span className="font-mono text-[11px]">{item.tools.join(", ") || "none"}</span>
                    .
                  </p>
                ) : null}
                <p
                  className={cn(
                    "text-[10px]",
                    item.history.started > 0 ? "text-foreground" : "text-muted-foreground",
                  )}
                  data-specialist-history
                >
                  {item.kind === "agent"
                    ? item.history.started > 0
                      ? `Started ${item.history.started} time${item.history.started === 1 ? "" : "s"}, ${item.history.done} finished. Last in ${item.history.last?.run}, ${item.history.last?.at}: ${item.history.last?.state}.`
                      : "Never started yet."
                    : "The engine keeps no record of this kind."}
                </p>
              </Block>
            ))}
          </>
        ) : null}

        {section === "seats" ? (
          <>
            {setup.flows.map((flow) => (
              <Block
                key={flow.id}
                name={flow.id}
                title={
                  <span className="flex items-center gap-1.5">
                    {flow.title}
                    {flow.id === setup.flow ? (
                      <Badge size="sm" variant="secondary">
                        chosen
                      </Badge>
                    ) : null}
                    <Badge
                      size="sm"
                      variant={!flow.offered ? "outline" : flow.ready ? "success" : "warning"}
                      data-flow-ready={flow.offered && flow.ready ? "true" : "false"}
                    >
                      {!flow.offered ? "not of this team" : flow.ready ? "can run" : "lacks seats"}
                    </Badge>
                  </span>
                }
              >
                <p className="text-muted-foreground">{flow.summary}</p>
                {flow.offered ? (
                  <p>
                    Seats that would take part:{" "}
                    <span className="font-mono text-[11px]">{flow.seats.join(", ") || "none"}</span>
                  </p>
                ) : (
                  <p>{flow.why}.</p>
                )}
                {flow.problems.map((item) => (
                  <p key={item} className="text-warning">
                    {item}
                  </p>
                ))}
              </Block>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
