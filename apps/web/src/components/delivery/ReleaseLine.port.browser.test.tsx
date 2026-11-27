import "~/index.css";

import type { DeploymentProject, DeploymentsSnapshot } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useBoardStore } from "../../state/deliveryBoard";
import { ReleaseLines } from "./ReleaseLine";
import recorded from "./ReleaseLine.ports.json";

const mock = vi.hoisted(() => ({ file: vi.fn(), toast: vi.fn(), compare: null as unknown }));
vi.mock(import("../../state/delivery"), async (importOriginal) => ({
  ...(await importOriginal()),
  useDeliveryRead: (_env: unknown, path: string | null) =>
    ({
      body: path?.startsWith("/api/deployments/compare")
        ? mock.compare
        : path === "/api/boards"
          ? [
              { id: "payoutlab-work", title: "PayoutLab", target: { repository: "payoutlab" } },
              { id: "other", title: "Other", target: { repository: "elsewhere" } },
            ]
          : null,
      error: null,
      isPending: false,
      readAt: "2026-11-27T13:00:00Z",
      failure: null,
      refresh: () => {},
    }) as never,
  useFilePort: () => ({ allowed: true, file: mock.file }),
}));
vi.mock(import("../ui/toast"), async (importOriginal) => ({
  ...(await importOriginal()),
  toastManager: { add: mock.toast } as never,
}));

const { points, ahead, folders } = recorded.withPorts;
const [unported, ported] = folders.commits.onlyFrom;
const instance = (id: string, extra: Partial<DeploymentProject>): DeploymentProject => ({
  id,
  repository: "payoutlab",
  title: "PayoutLab",
  branch: "main",
  environment: id,
  mode: "manual",
  adapter: "firebase-hosting",
  latestCommit: null,
  liveCommit: null,
  ...extra,
});
const snapshot: DeploymentsSnapshot = {
  version: 1,
  problem: null,
  projects: [
    instance("payoutlab-app", { environment: "app", liveCommit: points.toLive }),
    instance("payoutlab-qa", {
      environment: "qa",
      branch: "qa",
      liveCommit: points.fromLive,
      promotesTo: "app",
    }),
  ],
  candidates: [],
  lines: recorded.lines,
  repositories: [
    {
      id: "payoutlab",
      title: "PayoutLab",
      path: "/work/payoutlab",
      defaultBase: "main",
      branches: ["main", "qa"],
      kind: "git",
      ok: true,
    },
  ],
  capabilities: { engine: false, command: true, "firebase-hosting": true },
};

it("offers Port to app on the sandbox-only row without a port, files it, and shows the filed one", async () => {
  mock.file.mockResolvedValue({
    ok: true,
    filing: {
      created: true,
      task: {
        id: "task-new",
        number: 1002,
        board: "payoutlab-work",
        team: "development",
        state: "draft",
        origin: "deployment:host/payoutlab-qa..payoutlab-app",
      },
    },
  });
  mock.compare = recorded.withPorts;
  useBoardStore.getState().setPerson("Tevin");
  await using screen = await render(
    <ReleaseLines
      environmentId={"host" as never}
      snapshot={snapshot}
      unavailable={false}
      disabled
      onRequest={() => {}}
      onConfigure={() => {}}
    />,
  );
  const region = screen.getByRole("region", { name: "On qa, not on app" });
  const rowOf = (commit: string) =>
    [...region.element().querySelectorAll("[data-release-row]")].find((row) =>
      row.textContent?.includes(commit.slice(0, 7)),
    );
  // The PR that changes app/ is promoted, not ported; each sandbox commit offers one or the other.
  const pr = region.element().querySelector('[data-release-row="pr"]')!;
  expect(pr.querySelector("[data-release-port]")).toBeNull();
  expect(rowOf(ported!)?.querySelector("[data-release-port]")?.textContent).toBe(
    `Port filed: task #${ahead.ports[0]!.number}`,
  );
  expect(rowOf(unported!)?.querySelector("[data-release-port]")?.textContent).toBe("Port to app");

  await region.getByRole("button", { name: "Port to app" }).click();
  const dialog = screen.getByRole("alertdialog");
  await expect.element(dialog.getByText("qa · qa · serves sandbox/")).toBeVisible();
  await expect.element(dialog.getByText("app · main · serves app/")).toBeVisible();
  await expect.element(dialog.getByText(unported!.slice(0, 7))).toBeVisible();
  await expect.element(dialog.getByText("style(sandbox): payout colours")).toBeVisible();
  // The one board done in this repository is chosen; the ported commit is not offered again.
  await expect
    .element(dialog.getByRole("combobox", { name: "Board" }))
    .toHaveTextContent("PayoutLab");
  expect(dialog.element().textContent).not.toContain(ported!.slice(0, 7));

  // Who asked is shown, not typed: the server files as this environment.
  await expect.element(dialog.getByText("Requested by")).toBeVisible();
  expect(dialog.getByRole("textbox").elements()).toHaveLength(0);
  await dialog.getByRole("button", { name: "File port task" }).click();
  expect(mock.file).toHaveBeenCalledWith({
    board: "payoutlab-work",
    from: "payoutlab-qa",
    to: "payoutlab-app",
    requestedBy: "Tevin",
    commits: [unported],
  });
  // The dialog closes once the filing is answered, after its toast.
  await expect.element(dialog).not.toBeInTheDocument();
  expect(mock.toast).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "success", title: "Port filed as task #1002" }),
  );

  await rowOf(ported!)!.querySelector<HTMLButtonElement>("[data-release-port]")!.click();
  expect(screen.router?.state.location.search).toEqual({
    environment: "host",
    task: ahead.ports[0]!.task,
  });
});

it("ticks only the row it was opened from; the other unported commits stay listed, unticked", async () => {
  mock.file.mockReset();
  mock.file.mockResolvedValue({ ok: false, why: "not now" });
  // The recorded compare with its port withdrawn: both sandbox commits are offered.
  mock.compare = { ...recorded.withPorts, ahead: { ...ahead, ports: [] } };
  await using screen = await render(
    <ReleaseLines
      environmentId={"host" as never}
      snapshot={snapshot}
      unavailable={false}
      disabled
      onRequest={() => {}}
      onConfigure={() => {}}
    />,
  );
  const region = screen.getByRole("region", { name: "On qa, not on app" });
  const offers = [
    ...region.element().querySelectorAll<HTMLButtonElement>('[data-release-port="offer"]'),
  ];
  expect(offers).toHaveLength(2);
  // The older commit's row, the second listed.
  offers[1]!.click();
  const dialog = screen.getByRole("alertdialog");
  const ticks = dialog.getByRole("checkbox");
  await expect.element(ticks.nth(0)).not.toBeChecked();
  await expect.element(ticks.nth(1)).toBeChecked();
  await expect.element(dialog.getByText(unported!.slice(0, 7))).toBeVisible();
  await expect.element(dialog.getByText(ported!.slice(0, 7))).toBeVisible();
  await dialog.getByRole("button", { name: "File port task" }).click();
  expect(mock.file).toHaveBeenCalledWith(expect.objectContaining({ commits: [ported] }));
});
