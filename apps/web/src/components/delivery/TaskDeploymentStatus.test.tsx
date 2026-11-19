import { act, create, type ReactTestInstance } from "react-test-renderer";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { parseCard, type DeliveryCard } from "../../lib/delivery";
import { TaskDeploymentsPanel } from "./TaskDeploymentStatus";

const mock = vi.hoisted(() => ({ openPr: vi.fn(), openLink: vi.fn(async () => {}) }));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => mock.openPr }));
vi.mock("../../browser/useOpenLink", () => ({ useOpenLink: () => mock.openLink }));
vi.mock("../RelativeTime", () => ({
  RelativeTime: ({ timestamp }: { timestamp: string }) => `at ${timestamp}`,
}));
vi.mock("./TaskDisclosure", () => ({
  TaskDisclosure: (props: { title: ReactNode; children: ReactNode }) => (
    <details>
      <summary>{props.title}</summary>
      {props.children}
    </details>
  ),
}));

const project = (environment: string) => ({
  id: `app-${environment}`,
  repository: "alias",
  path: "/real/app",
  environment,
  branch: "main",
  mode: "manual",
  title: "App",
});
const publication = (environment: string, id: string, extra: Record<string, unknown> = {}) => ({
  publication: id,
  run: "run-1",
  task: "task-1",
  board: "original",
  projectId: `app-${environment}`,
  repositoryPath: "/real/app",
  targetBranch: "main",
  project: project(environment),
  headCommit: "a".repeat(40),
  pullRequest: { number: 42, url: "https://github.com/owner/app/pull/42" },
  publicationState: "merged",
  mergeCommit: "c".repeat(40),
  state: "queued",
  problem: null,
  candidate: null,
  history: [],
  updated: "2030-01-01T00:00:00.000Z",
  ...extra,
});

function card(deployment: unknown): DeliveryCard {
  const parsed = parseCard({ deployment })!;
  return { ...parsed, run: { id: "run-1" } as DeliveryCard["run"] };
}

function render(value: DeliveryCard, stale = false) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<TaskDeploymentsPanel card={value} stale={stale} />);
  });
  return renderer.root;
}

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
const rows = (root: ReactTestInstance) =>
  root.findAll((node) => typeof node.props["data-task-deployment-environment"] === "string");
const links = (node: ReactTestInstance) =>
  node.findAllByType("a").map((link) => [text(link), link.props.href as string]);

describe("TaskDeploymentsPanel", () => {
  it("lays out one row per environment, newest publication first, with PR link and time", () => {
    const root = render(
      card({
        current: publication("production", "p-2"),
        history: [publication("staging", "s-1"), publication("production", "p-1")],
      }),
    );
    expect(rows(root).map((row) => row.props["data-task-deployment-environment"])).toEqual([
      "production",
      "staging",
    ]);
    const production = rows(root)[0]!;
    expect(text(production)).toContain("queued");
    expect(text(production)).toContain("at 2030-01-01T00:00:00.000Z");
    expect(links(production)).toEqual([["PR #42", "https://github.com/owner/app/pull/42"]]);
    // The older production publication is in that row's details, not a row of its own.
    expect(
      production.findAll((node) => node.props["data-task-deployment-publication"] === true),
    ).toHaveLength(2);
    expect(text(root)).toContain("2 environments");
  });

  it("shows engine-reported preview, deployment id and logs only when present", () => {
    const without = render(card({ current: publication("production", "p-1"), history: [] }));
    expect(text(without)).not.toContain("Deployment ");
    expect(links(without).map(([label]) => label)).toEqual(["PR #42"]);

    const root = render(
      card({
        current: publication("production", "p-1", {
          previewUrl: "https://preview.example.com",
          deploymentId: "dep-7",
          logsUrl: "https://logs.example.com/dep-7",
        }),
        history: [],
      }),
    );
    expect(links(root)).toEqual([
      ["PR #42", "https://github.com/owner/app/pull/42"],
      ["Preview", "https://preview.example.com"],
      ["Logs", "https://logs.example.com/dep-7"],
    ]);
    expect(text(root)).toContain("Deployment dep-7");
    const preview = root.findAllByType("a")[1]!;
    const event = { button: 0, preventDefault: vi.fn(), metaKey: false, ctrlKey: false };
    act(() => preview.props.onClick(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(mock.openLink).toHaveBeenCalledWith("https://preview.example.com", { event });
  });

  it("says when there is no deployment, and when the snapshot or run is not current", () => {
    expect(text(render(card(null)))).toContain("A merge does not mean this task is live.");
    const stale = render(
      card({ current: publication("production", "p-1", { run: "run-0" }), history: [] }),
      true,
    );
    expect(text(stale)).toContain("Stale snapshot. This is not current deployment evidence.");
    expect(text(stale)).toContain("This publication belongs to an earlier run.");
  });
});
