import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseCard, type CouncilSeat, type TaskView } from "../../lib/delivery";
import { TaskTeamActivity } from "./TaskTeamActivity";

const mock = vi.hoisted(() => ({ tooltips: [] as Array<Record<string, unknown>> }));
vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useMessages: () => (text: string) => text,
}));
vi.mock("./SeatSettingsPanel", () => ({
  useSeatCatalog: () => ({
    entries: [
      {
        instanceId: "claudeAgent",
        driverKind: "claudeAgent",
        displayName: "Claude",
        isDefault: true,
      },
    ],
    providers: [],
    options: {},
  }),
  SeatSettingsPanel: () => <p data-seat-settings />,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: (props: { children: ReactNode }) => <div>{props.children}</div>,
  TooltipTrigger: (props: { children: ReactNode }) => <div data-trigger>{props.children}</div>,
}));
vi.mock("../ThreadHoverCard", () => ({
  ThreadHoverCardPopup: (props: { children: ReactNode }) => <aside>{props.children}</aside>,
}));
vi.mock("../chat/SubagentTooltipContent", () => ({
  SubagentTooltipContent: (props: Record<string, unknown>) => {
    mock.tooltips.push(props);
    return null;
  },
}));
vi.mock("../chat/AgentElapsed", () => ({
  AgentElapsed: (props: { agent: { startedAt: string | null } }) => (
    <time>{props.agent.startedAt}</time>
  ),
}));
vi.mock("../chat/ThreadRelationshipIcon", () => ({
  ThreadRelationshipIcon: (props: { driver?: string; status: string }) => (
    <i data-driver={props.driver ?? "none"} data-status={props.status} />
  ),
  threadRelationshipStatusLabel: (status: string) => `label:${status}`,
}));

const seat = (extra: Partial<CouncilSeat>): CouncilSeat => ({
  seat: "builder",
  role: "build",
  harness: "claude",
  provider: "claude",
  required: true,
  requestedModel: "claude-opus",
  actualModel: null,
  reasoning: "high",
  access: "full",
  activity: "active",
  blockedBy: null,
  waitingWhy: null,
  stage: "build",
  verdict: null,
  attempts: 1,
  live: null,
  ...extra,
});

function taskWith(seats: ReadonlyArray<CouncilSeat> | null): TaskView {
  return {
    id: "task-1",
    team: "development",
    defaults: 2,
    lane: "implementation",
    publications: [],
    settings: [],
    card: parseCard({ lane: "implementation" })!,
    council: seats === null ? null : ({ seats } as unknown as TaskView["council"]),
  } as unknown as TaskView;
}

let renderer: ReactTestRenderer;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mock.tooltips = [];
});
afterEach(async () => {
  await act(() => renderer?.unmount());
});

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");

async function render(task: TaskView) {
  await act(() => {
    renderer = create(<TaskTeamActivity environmentId={null} task={task} />);
  });
  return renderer.root;
}

describe("TaskTeamActivity", () => {
  it("shows each seat as a native agent row with its harness, status and what it does", async () => {
    const root = await render(
      taskWith([
        seat({
          live: {
            started: "2030-01-01T00:00:00.000Z",
            updated: "2030-01-01T00:01:00.000Z",
            items: [{ kind: "tool", text: "vp test run" }],
          },
        }),
        seat({
          seat: "reviewer",
          harness: "codex",
          activity: "waiting",
          blockedBy: "builder",
          waitingWhy: "Waits for the build to finish.",
        }),
        seat({ seat: "qa", activity: "unavailable", stage: null }),
      ]),
    );
    const rows = root.findAll((node) => typeof node.props["data-task-seat"] === "string");
    expect(rows.map((row) => row.props["data-task-seat"])).toEqual(["builder", "reviewer", "qa"]);

    const icons = root.findAllByType("i");
    expect(icons.map((icon) => [icon.props["data-driver"], icon.props["data-status"]])).toEqual([
      ["claudeAgent", "running"],
      ["codex", "waiting"],
      ["claudeAgent", "idle"],
    ]);
    const details = root.findAll((node) => node.props["data-seat-detail"] === true);
    expect(details.map(text)).toEqual(["build", "waits for builder", "unavailable"]);

    // Elapsed time only for the seat at work, from when its live output started.
    expect(root.findAllByType("time").map(text)).toContain("2030-01-01T00:00:00.000Z");
    expect(text(rows[0]!)).toContain("vp test run");
    expect(text(rows[0]!)).toContain("Claude, claude-opus, high");
    expect(text(rows[1]!)).toContain("Waits for the build to finish.");

    // The native hover card carries the seat, its model, and its latest progress.
    expect(mock.tooltips.map((props) => [props.title, props.status, props.progress])).toEqual([
      ["builder", "running", "vp test run"],
      ["reviewer", "waiting", null],
      ["qa", "idle", null],
    ]);
    expect(mock.tooltips[1]!.result).toBe("Waits for the build to finish.");
  });

  it("titles the roster with the team and how many seats run", async () => {
    const root = await render(taskWith([seat({}), seat({ seat: "qa", activity: "queued" })]));
    expect(root.findAllByType("h3").map(text)).toContain(
      "Team development, defaults r2 · 1 running",
    );
  });

  it("shows the pipeline strip and the seat settings before a run has seats", async () => {
    const root = await render(taskWith(null));
    expect(root.findAll((node) => node.props["data-seat-settings"] === true)).toHaveLength(1);
    const strip = root.find((node) => typeof node.props["data-task-pipeline"] === "string");
    expect(strip.props["data-task-pipeline"]).toBe("Building");
    const current = strip.find((node) => node.props["aria-current"] === "step");
    expect(text(current)).toContain("Building, now");
  });
});
