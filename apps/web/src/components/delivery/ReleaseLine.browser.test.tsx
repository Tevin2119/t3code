import "~/index.css";

import type { DeploymentProject, DeploymentsSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ReleaseLines } from "./ReleaseLine";
import recorded from "./ReleaseLine.fixtures.json";

const mock = vi.hoisted(() => ({
  compare: null as unknown,
  reads: [] as string[],
  openPr: vi.fn(),
}));
vi.mock(import("../../state/delivery"), async (importOriginal) => ({
  ...(await importOriginal()),
  useDeliveryRead: (_env: unknown, path: string | null) => {
    if (path) mock.reads.push(path);
    return {
      body: path?.startsWith("/api/deployments/compare") ? mock.compare : null,
      error: null,
      isPending: false,
      readAt: "2026-11-27T02:00:00Z",
      failure: null,
      refresh: () => {},
    } as never;
  },
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProjects: () =>
    [
      {
        workspaceRoot: "/work/t3code",
        repositoryIdentity: {
          canonicalKey: "github.com/tevin2119/t3code",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@github.com:Tevin2119/t3code.git",
          },
          provider: "github",
          owner: "Tevin2119",
          name: "t3code",
        },
      },
    ] as never,
}));
vi.mock(import("../../lib/openPullRequestLink"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOpenPrLink: () => (event: { preventDefault: () => void }, url: string) => {
    event.preventDefault();
    mock.openPr(url);
    return true;
  },
}));

function setup(compare: unknown) {
  mock.compare = compare;
  mock.reads = [];
  mock.openPr.mockReset();
}

const instance = (id: string, extra: Partial<DeploymentProject>): DeploymentProject => ({
  id,
  repository: "t3code",
  title: "T3 Code",
  branch: "main",
  environment: id,
  mode: "manual",
  adapter: "firebase-hosting",
  latestCommit: null,
  liveCommit: null,
  ...extra,
});
const { points } = recorded.withHotfix;
const snapshot: DeploymentsSnapshot = {
  version: 1,
  problem: null,
  projects: [
    instance("t3code-app", {
      environment: "app",
      liveCommit: points.toLive,
      latestCommit: points.toTip,
      liveObservedAt: "2026-11-27T01:00:00Z",
      liveAdoptedBy: "Sam",
      firebase: { firebaseProject: "demo-site", target: "app" },
    }),
    instance("t3code-qa", {
      environment: "qa",
      branch: "qa",
      liveCommit: points.fromLive,
      latestCommit: points.fromTip,
      promotesTo: "app",
      firebase: { firebaseProject: "demo-site", target: "sandbox" },
    }),
  ],
  candidates: [],
  lines: recorded.lines,
  repositories: [
    {
      id: "t3code",
      title: "T3 Code",
      path: "/work/t3code",
      defaultBase: "main",
      branches: ["main", "qa"],
      kind: "git",
      ok: true,
    },
  ],
  capabilities: { engine: false, command: true, "firebase-hosting": true },
};

const lines = () => (
  <ReleaseLines
    environmentId={"host" as never}
    snapshot={snapshot}
    unavailable={false}
    disabled
    onRequest={() => {}}
    onConfigure={() => {}}
  />
);

it("draws the line in promotion order with the recorded difference between qa and app", async () => {
  setup(recorded.withHotfix);
  await using screen = await render(lines());
  const order = [...screen.container.querySelectorAll("[data-release-instance]")].map((node) =>
    node.getAttribute("data-release-instance"),
  );
  expect(order).toEqual(["qa", "app"]);
  expect(mock.reads).toContain("/api/deployments/compare?from=t3code-qa&to=t3code-app");

  const ahead = screen.getByRole("region", { name: "On qa, not on app" });
  const rows = [...ahead.element().querySelectorAll("[data-release-row]")].map((node) =>
    node.getAttribute("data-release-row"),
  );
  expect(rows).toEqual(["pr", "pr", "commit", "commit", "task"]);
  await expect
    .element(screen.getByRole("region", { name: "On app, not in qa" }).getByText(/#15/))
    .toBeVisible();
  await expect.element(screen.getByText(/Sync hotfixes first: app has 1 commit/)).toBeVisible();
  await expect
    .element(screen.getByText(/2 commits change only/))
    .toHaveTextContent("2 commits change only sandbox/. Promoting them changes nothing on app.");
  await expect.element(screen.getByText(/adopted by Sam/)).toBeVisible();
});

it("opens each PR's detail, from the engine's URL or the repository's, and a task row its task", async () => {
  setup(recorded.withHotfix);
  await using screen = await render(lines());
  const ahead = screen.getByRole("region", { name: "On qa, not on app" });
  await ahead.getByRole("link", { name: /#12 / }).click();
  expect(mock.openPr).toHaveBeenLastCalledWith("https://github.com/Tevin2119/t3code/pull/12");
  await ahead.getByRole("link", { name: /#14 / }).click();
  expect(mock.openPr).toHaveBeenLastCalledWith(expect.stringMatching(/\/pull\/14$/));
  await ahead.getByRole("button", { name: /Release-line strip on Deployments/ }).click();
  expect(screen.router?.state.location.pathname).toBe("/board");
  expect(screen.router?.state.location.search).toEqual({ environment: "host", task: "task-strip" });
});

it("offers a plain promotion with no hotfix line when the instances are in sync", async () => {
  setup(recorded.inSync);
  await using screen = await render(lines());
  const hotfixes = screen.getByRole("region", { name: "On app, not in qa" });
  await expect.element(hotfixes).toBeVisible();
  expect(hotfixes.element().querySelectorAll("[data-release-row]")).toHaveLength(0);
  expect(screen.container.querySelector("[data-release-promote]")).toBeNull();
});
