import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseCard, type CouncilSeat, type TaskView } from "../../lib/delivery";
import { SeatThreadRow, TaskPipelineStrip } from "./TaskTeamActivity";

const mock = vi.hoisted(() => ({ tooltips: [] as Array<Record<string, unknown>> }));
vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useMessages: () => (text: string) => text,
}));
const catalog = {
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
} as unknown as Parameters<typeof SeatThreadRow>[0]["catalog"];
// The shared open handlers need the translation runtime; the browser test clicks the row.
vi.mock("../../hooks/useSideThreadTrigger", () => ({
  useSideThreadTrigger: () => () => ({}),
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
  cutByT3: null,
  live: null,
  threadId: null,
  ...extra,
});

function taskWith(
  seats: ReadonlyArray<CouncilSeat> | null,
  extra: Partial<TaskView> = {},
): TaskView {
  return {
    id: "task-1",
    team: "development",
    defaults: 2,
    lane: "implementation",
    publications: [],
    settings: [],
    card: parseCard({ lane: "implementation" })!,
    ...extra,
    council: seats === null ? null : ({ seats } as unknown as TaskView["council"]),
  } as unknown as TaskView;
}

// A deployment that reached live with its candidate, as the engine reports one.
const livePublication = {
  publication: "p-1",
  run: "run-1",
  task: "task-1",
  board: "original",
  projectId: "app-production",
  repositoryPath: "/real/app",
  targetBranch: "main",
  project: {
    id: "app-production",
    repository: "alias",
    path: "/real/app",
    environment: "production",
    branch: "main",
    mode: "manual",
    title: "App",
  },
  headCommit: "a".repeat(40),
  pullRequest: { number: 42, url: "https://github.com/owner/app/pull/42" },
  publicationState: "merged",
  mergeCommit: "c".repeat(40),
  state: "live",
  problem: null,
  candidate: {
    id: "cand-1",
    commit: "c".repeat(40),
    branch: "main",
    state: "live",
    inclusion: null,
    evidence: null,
    problem: null,
    failedPhase: null,
    liveAt: "2030-01-01T00:00:00.000Z",
    liveUntil: null,
  },
  history: [],
  updated: "2030-01-01T00:00:00.000Z",
};

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
    renderer = create(
      <div>
        <TaskPipelineStrip task={task} />
        <ul>
          {(task.council?.seats ?? []).map((item) => (
            <SeatThreadRow key={item.seat} seat={item} catalog={catalog} onOpen={() => {}} />
          ))}
        </ul>
      </div>,
    );
  });
  return renderer.root;
}

describe("a seat's conversation row and the task's flow", () => {
  it("shows each seat as a lineage row with its harness, status and what it does", async () => {
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

    // The native hover card carries the seat, its model, and its latest progress.
    expect(mock.tooltips.map((props) => [props.title, props.status, props.progress])).toEqual([
      ["builder", "running", "vp test run"],
      ["reviewer", "waiting", null],
      ["qa", "idle", null],
    ]);
    expect(mock.tooltips[1]!.result).toBe("Waits for the build to finish.");
  });

  it("shows the pipeline strip before a run has seats", async () => {
    const root = await render(taskWith(null));
    const strip = root.find((node) => typeof node.props["data-task-pipeline"] === "string");
    expect(strip.props["data-task-pipeline"]).toBe("Building");
    const current = strip.find((node) => node.props["aria-current"] === "step");
    expect(text(current)).toContain("Building, now");
  });

  it("puts aria-current on the tinted step once a step is settled, and on none once Live", async () => {
    const stepsOf = (root: ReactTestInstance) =>
      root.find((node) => typeof node.props["data-task-pipeline"] === "string").findAllByType("li");
    const currentOf = (root: ReactTestInstance) =>
      stepsOf(root)
        .filter((node) => node.props["aria-current"] === "step")
        .map(text);

    // Merged is settled: its marker shows done and the tint sits on Deploying, so Deploying is
    // the current step, not Merged.
    const merged = await render(
      taskWith(null, {
        lane: "completed",
        publications: [{ state: "merged" }] as unknown as TaskView["publications"],
      }),
    );
    expect(currentOf(merged)).toHaveLength(1);
    expect(currentOf(merged)[0]).toContain("Deploying, next");
    expect(text(stepsOf(merged)[3]!)).toContain("Merged, done");

    // Live is settled at the last step: every marker is done and nothing is current.
    const live = await render(
      taskWith(null, {
        card: parseCard({
          lane: "completed",
          deployment: { current: livePublication, history: [] },
        })!,
      }),
    );
    expect(live.find((node) => node.props["data-task-pipeline"] === "Live")).toBeTruthy();
    expect(currentOf(live)).toEqual([]);
  });
});
