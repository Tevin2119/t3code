import "~/index.css";

import type {
  DeploymentProject,
  DeploymentPromotion,
  DeploymentsSnapshot,
} from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DeploymentApproval, type DeploymentRequest } from "./DeploymentInstance";
import { ReleaseLines } from "./ReleaseLine";
import recorded from "./ReleaseLine.fixtures.json";
import promotions from "./ReleaseLine.promotions.json";

const PERMISSION = Symbol("permission");
const mock = vi.hoisted(() => ({
  compare: null as unknown,
  acts: [] as Array<{ path: string; body: unknown }>,
}));
vi.mock(import("@effect/atom-react"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    useAtomValue: ((atom: unknown) =>
      atom === PERMISSION ? true : original.useAtomValue(atom as never)) as never,
  };
});
vi.mock(import("../../state/delivery"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    deliveryEnvironment: {
      ...original.deliveryEnvironment,
      act: { ...original.deliveryEnvironment.act, permissionAtom: () => PERMISSION },
    } as never,
    usePersonName: () => "Ben",
    useDeliveryAct: () => async (path: string, body: unknown) => {
      mock.acts.push({ path, body });
      return { ok: true, body: {} };
    },
    useDeliveryRead: (_env: unknown, path: string | null) =>
      ({
        body: path?.startsWith("/api/deployments/compare") ? mock.compare : null,
        error: null,
        isPending: false,
        readAt: "2026-11-27T02:00:00Z",
        failure: null,
        refresh: () => {},
      }) as never,
  };
});

const states = promotions.states as unknown as Record<string, DeploymentPromotion>;
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
const snapshotWith = (promotion: DeploymentPromotion | null): DeploymentsSnapshot => ({
  version: 1,
  problem: null,
  projects: [
    instance("t3code-app", { environment: "app", liveCommit: points.toLive }),
    instance("t3code-qa", {
      environment: "qa",
      branch: "qa",
      liveCommit: points.fromLive,
      promotesTo: "app",
    }),
  ],
  candidates: [],
  lines: recorded.lines,
  promotions: promotion ? [promotion] : [],
  repositories: [],
  capabilities: { engine: false, command: true, "firebase-hosting": true },
});

/** The strip with Deployments' own approval dialog behind it, as both pages wire it. */
function Harness({
  promotion,
  disabled = false,
  unavailable = false,
}: {
  promotion: DeploymentPromotion | null;
  disabled?: boolean;
  unavailable?: boolean;
}) {
  const [request, setRequest] = useState<DeploymentRequest | null>(null);
  return (
    <>
      <ReleaseLines
        environmentId={"host" as never}
        snapshot={snapshotWith(promotion)}
        unavailable={unavailable}
        disabled={disabled}
        onRequest={setRequest}
        onConfigure={() => {}}
      />
      {request ? (
        <DeploymentApproval
          environmentId={"host" as never}
          request={request}
          unavailable={false}
          onClose={() => setRequest(null)}
          onDone={() => setRequest(null)}
        />
      ) : null}
    </>
  );
}

function setup(compare: unknown) {
  mock.compare = compare;
  mock.acts = [];
}

async function sign() {
  await page.getByLabelText("Approval passphrase").fill("passphrase");
  await page.getByRole("button", { name: "Confirm" }).click();
}

it("syncs hotfixes first when app has commits qa lacks, confirming what moves, then signed", async () => {
  setup(recorded.withHotfix);
  await using screen = await render(<Harness promotion={null} />);
  expect(screen.container.querySelector("[data-instance-state][data-promotion-state]")).toBeNull();
  await screen.getByRole("button", { name: "Sync hotfixes first" }).click();
  const moves = page.getByText(/^Merges main \(/);
  await expect.element(moves).toBeVisible();
  await expect
    .element(moves)
    .toHaveTextContent(
      `Merges main (${points.toTip.slice(0, 12)}, 1 commit qa lacks) into qa (${points.fromTip.slice(0, 12)}) and pushes the merge to qa. main moves only once qa runs and verifies that sync. Then it waits, ready, for a named person to advance main.`,
    );
  await page.getByRole("button", { name: "Sync first…" }).click();
  await expect.element(page.getByText("Sync hotfixes into qa first")).toBeVisible();
  await sign();
  expect(mock.acts).toEqual([
    {
      path: "/api/deployments/promotions",
      body: { from: "t3code-qa", to: "t3code-app", by: "Ben", key: "passphrase" },
    },
  ]);
});

it("promotes straight away when the instances are in sync, and Cancel sends nothing", async () => {
  setup({
    ...recorded.inSync,
    to: { ...recorded.inSync.to, id: "t3code-app", environment: "app" },
  });
  await using screen = await render(<Harness promotion={null} />);
  await screen.getByRole("button", { name: "Promote to app" }).click();
  await expect
    .element(page.getByText(/^Moves release to qa's verified live commit/))
    .toHaveTextContent(
      `Moves release to qa's verified live commit ${recorded.inSync.points.fromLive.slice(0, 12)}, with a plain push that is never forced.`,
    );
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.element(page.getByText(/^Moves release to/)).not.toBeInTheDocument();
  expect(mock.acts).toEqual([]);
});

it("shows each recorded open promotion's state and reason unchanged, with the engine's actions", async () => {
  setup(recorded.withHotfix);
  for (const [name, actions] of [
    ["conflicted", ["Retry", "Cancel promotion"]],
    ["blocked", ["Retry", "Cancel promotion"]],
    ["awaiting-qa", ["Cancel promotion"]],
    ["ready", ["Advance", "Cancel promotion"]],
    ["syncing", []],
  ] as const) {
    const promotion = states[name]!;
    await using screen = await render(<Harness promotion={promotion} />);
    const strip = screen.container.querySelector(`[data-promotion-state="${name}"]`);
    expect(strip, name).not.toBeNull();
    const reason = promotion.problem ?? promotion.waiting ?? null;
    expect(strip!.querySelector("[data-promotion-reason]")?.textContent ?? null, name).toBe(reason);
    const buttons = [...screen.container.querySelectorAll("[data-release-promotion] button")].map(
      (node) => node.textContent,
    );
    expect(buttons, name).toEqual(actions);
  }
});

it("advances a ready promotion through the same confirmation and approval", async () => {
  setup(recorded.withHotfix);
  const ready = states["ready"]!;
  await using screen = await render(<Harness promotion={ready} />);
  await expect.element(screen.getByText("Ready to advance")).toBeVisible();
  await screen.getByRole("button", { name: "Advance" }).click();
  await expect
    .element(page.getByText(new RegExp(`^Moves main to ${ready.source!.slice(0, 12)}`)))
    .toBeVisible();
  await page.getByRole("button", { name: "Advance…" }).click();
  await sign();
  expect(mock.acts).toEqual([
    {
      path: `/api/deployments/promotions/${ready.id}/action`,
      body: { action: "advance", by: "Ben", key: "passphrase" },
    },
  ]);
});

it("offers a new promotion again once the last one was promoted or cancelled", async () => {
  setup(recorded.withHotfix);
  await using screen = await render(<Harness promotion={states["promoted"]!} />);
  await expect.element(screen.getByText("Promoted", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Sync hotfixes first" })).toBeVisible();
});

it("shows a state this T3 does not know by its name and reason, with cancel as its way out", async () => {
  setup(recorded.withHotfix);
  // D3b adds states; this one is the recorded conflicted promotion renamed.
  const later = {
    ...states["conflicted"]!,
    state: "awaiting-merge",
    problem: "Sync PR #7 waits for its checks.",
  };
  await using screen = await render(<Harness promotion={later} />);
  await expect.element(screen.getByText("awaiting-merge")).toBeVisible();
  await expect.element(screen.getByText("Sync PR #7 waits for its checks.")).toBeVisible();
  await screen.getByRole("button", { name: "Cancel promotion" }).click();
  await page.getByRole("button", { name: "Cancel promotion…" }).click();
  await sign();
  expect(mock.acts.at(-1)).toEqual({
    path: `/api/deployments/promotions/${later.id}/action`,
    body: { action: "cancel", by: "Ben", key: "passphrase" },
  });
});

it("disables every promotion button with the reason when the connection may not act", async () => {
  setup(recorded.withHotfix);
  await using screen = await render(<Harness promotion={states["blocked"]!} disabled />);
  await expect.element(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Cancel promotion" })).toBeDisabled();
  await expect
    .element(screen.getByText("This connection does not have permission to change deployments."))
    .toBeVisible();
});

it("disables promoting on a stale reading, and says so", async () => {
  setup(recorded.withHotfix);
  await using screen = await render(<Harness promotion={null} disabled unavailable />);
  await expect.element(screen.getByRole("button", { name: "Sync hotfixes first" })).toBeDisabled();
  await expect
    .element(screen.getByText("This reading is stale or unavailable. Refresh before promoting."))
    .toBeVisible();
});
