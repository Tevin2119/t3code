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
import syncConflicts from "./ReleaseLine.syncConflicts.json";
import { buildSyncConflictsPrompt } from "../pullRequest/pullRequestDetail.logic";

const PERMISSION = Symbol("permission");
const handoffs = vi.hoisted(() => ({
  details: [] as unknown[],
  started: [] as Array<{ kind: string; task: unknown }>,
}));
// T3's own PR hand-off: the card must hand it the sync PR and the sync prompt, nothing else.
vi.mock(import("../pullRequest/usePullRequestActions"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    usePullRequestHandoffs: ({ detail }: { detail: unknown }) => {
      handoffs.details.push(detail);
      return {
        handoff: null,
        startHandoff: async (kind: string, task: unknown) => {
          handoffs.started.push({ kind, task });
        },
      } as never;
    },
  };
});
const checkedOut = vi.hoisted(() => ({ projects: [] as unknown[] }));
vi.mock(import("../../state/entities"), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, useProjects: () => checkedOut.projects as never };
});
const mock = vi.hoisted(() => ({
  compare: null as unknown,
  /** What the next refresh reads, when it differs from what is shown. */
  next: undefined as unknown,
  readAt: "",
  error: null as string | null,
  refreshes: 0,
  listeners: new Set<() => void>(),
  acts: [] as Array<{ path: string; body: unknown }>,
}));
// A refresh is a new reading, as the engine query gives: a later readAt, maybe a new body.
const refresh = () => {
  mock.refreshes += 1;
  mock.readAt = new Date(Date.parse(mock.readAt) + 1_000).toISOString();
  if (mock.next !== undefined) mock.compare = mock.next;
  for (const listener of mock.listeners) listener();
};
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
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mock.listeners.add(listener);
    return () => mock.listeners.delete(listener);
  };
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
    useDeliveryRead: (_env: unknown, path: string | null) => {
      const readAt = useSyncExternalStore(subscribe, () => mock.readAt);
      const body = useSyncExternalStore(subscribe, () => mock.compare);
      const compare = path?.startsWith("/api/deployments/compare");
      return {
        body: compare ? body : null,
        error: compare ? mock.error : null,
        isPending: false,
        readAt,
        failure: null,
        refresh,
      } as never;
    },
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

function setup(compare: unknown, options: { readAt?: string; error?: string } = {}) {
  mock.compare = compare;
  mock.next = undefined;
  // A fixed epoch ahead of any runner's clock reads as fresh.
  mock.readAt = options.readAt ?? "2999-01-01T00:00:00.000Z";
  mock.error = options.error ?? null;
  mock.refreshes = 0;
  mock.acts = [];
  handoffs.details = [];
  handoffs.started = [];
  checkedOut.projects = [];
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
  // A later engine may add states; this one is the recorded conflicted promotion renamed.
  const later = {
    ...states["conflicted"]!,
    state: "awaiting-checks",
    problem: "Sync PR #7 waits for its checks.",
  };
  await using screen = await render(<Harness promotion={later} />);
  await expect.element(screen.getByText("awaiting-checks")).toBeVisible();
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

it("re-reads the difference when the dialog opens and shows the commits it read", async () => {
  setup(recorded.withHotfix);
  const moved = "a".repeat(40);
  mock.next = { ...recorded.withHotfix, points: { ...points, toTip: moved } };
  await using screen = await render(<Harness promotion={null} />);
  await screen.getByRole("button", { name: "Sync hotfixes first" }).click();
  await expect
    .element(
      page.getByText(`Merges main (${moved.slice(0, 12)}, 1 commit qa lacks)`, { exact: false }),
    )
    .toBeVisible();
  expect(mock.refreshes).toBe(1);
  await page.getByRole("button", { name: "Sync first…" }).click();
  await sign();
  // The engine accepted it: the difference is read again.
  expect(mock.refreshes).toBe(2);
});

it("refuses in the dialog when the fresh read shows the tip already holds the commit", async () => {
  setup(recorded.inSync);
  mock.next = promotions.compareAfterPromoted;
  await using screen = await render(<Harness promotion={null} />);
  await screen.getByRole("button", { name: /^Promote to/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog.getByText(/Waiting for app to deploy it\.$/)).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: /^Promote/ })).toBeDisabled();
});

it("after a recorded promotion, waits for the instance to deploy instead of promoting again", async () => {
  setup(promotions.compareAfterPromoted);
  await using screen = await render(<Harness promotion={states["promoted"]!} />);
  await expect.element(screen.getByRole("button", { name: "Promote to app" })).toBeDisabled();
  await expect.element(screen.getByText(/^main already holds qa's live commit/)).toBeVisible();
});

it("disables promoting and advancing while the difference is stale or failed, and says why", async () => {
  setup(recorded.withHotfix, { readAt: "2026-01-01T00:00:00.000Z" });
  {
    await using screen = await render(<Harness promotion={null} />);
    await expect
      .element(screen.getByRole("button", { name: "Sync hotfixes first" }))
      .toBeDisabled();
    await expect.element(screen.getByText(/The difference is out of date/)).toBeVisible();
  }
  setup(recorded.withHotfix, { error: "The engine did not answer." });
  await using screen = await render(<Harness promotion={states["ready"]!} />);
  await expect.element(screen.getByRole("button", { name: "Advance" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Cancel promotion" })).toBeEnabled();
  await expect
    .element(screen.getByText("The difference could not be read: The engine did not answer."))
    .toBeVisible();
});

// D3b: recorded from the engine's promotions.mjs at 0cef3352 (ReleaseLine.syncConflicts.json).
const sync = syncConflicts.states as unknown as Record<string, DeploymentPromotion>;
const T3_PROJECT = {
  id: "project-t3code",
  environmentId: "host",
  workspaceRoot: "/work/t3code",
  repositoryIdentity: {
    canonicalKey: "github.com/tevin2119/t3code-fixture",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:Tevin2119/t3code-fixture.git",
    },
    provider: "github",
    rootPath: "/work/t3code",
  },
};

it("hands a conflicted sync PR to T3's own Resolve conflicts, naming the hotfixes that must survive", async () => {
  setup(recorded.withHotfix);
  checkedOut.projects = [T3_PROJECT];
  const conflicted = sync["conflicted"]!;
  await using screen = await render(<Harness promotion={conflicted} />);
  await expect.element(screen.getByText("Conflicted")).toBeVisible();
  await expect.element(screen.getByRole("link", { name: "Sync PR #7" })).toBeVisible();
  await expect.element(screen.getByText("Hotfixes that must survive (3)")).toBeVisible();
  await expect.element(screen.getByText("#41 fix: pause refunds")).toBeVisible();
  await expect.element(screen.getByText("fix: price rounding")).toBeVisible();
  await expect.element(screen.getByText("app/price.txt", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Resolve conflicts" }).click();
  expect(handoffs.details.at(-1)).toEqual({
    projectId: "project-t3code",
    workspaceRoot: "/work/t3code",
    url: conflicted.syncPr!.url,
  });
  expect(handoffs.started).toEqual([
    {
      kind: "conflicts",
      task: {
        prompt: buildSyncConflictsPrompt({
          number: 7,
          url: conflicted.syncPr!.url!,
          headBranch: `paperclip/sync/${conflicted.id}`,
          baseBranch: "qa",
          promotionId: conflicted.id,
          fromBranch: "qa",
          toBranch: "main",
          hotfixes: conflicted.hotfixes!,
        }),
      },
    },
  ]);
  // The promotion's own way out stays.
  await expect.element(screen.getByRole("button", { name: "Cancel promotion" })).toBeEnabled();
  expect(mock.acts).toEqual([]);
});

it("says why Resolve conflicts is unavailable when T3 has no project for the repository", async () => {
  setup(recorded.withHotfix);
  await using screen = await render(<Harness promotion={sync["conflicted"]!} />);
  await expect.element(screen.getByRole("button", { name: "Resolve conflicts" })).toBeDisabled();
  await expect
    .element(screen.getByText(/^Add this repository's folder as a T3 project/))
    .toBeVisible();
});

it("shows the survival report with missing and changed hunks first, and approves its head", async () => {
  setup(recorded.withHotfix);
  const resolved = sync["resolved"]!;
  const head = resolved.resolution!.head;
  await using screen = await render(<Harness promotion={resolved} />);
  await expect.element(screen.getByText("Resolved, awaiting approval")).toBeVisible();
  const statuses = [...screen.container.querySelectorAll("[data-survival-status]")].map((row) =>
    row.getAttribute("data-survival-status"),
  );
  expect(statuses).toEqual(["missing", "changed", "superseded", "present"]);
  const missing = screen.container.querySelector('[data-survival-status="missing"]')!;
  expect(missing.textContent).toContain("app/price.txt");
  expect(missing.querySelector("pre")?.textContent).toBe("-price = 10\n+price = 11");
  expect(missing.querySelector(".text-destructive")).not.toBeNull();
  const changed = screen.container.querySelector('[data-survival-status="changed"]')!;
  expect(changed.querySelector(".text-warning-foreground")).not.toBeNull();
  expect(screen.container.querySelector('[data-survival-status="present"] pre')).toBeNull();
  // On a wide card the hash sits right after its path, not at the far edge.
  const [path, hash] = [...missing.querySelectorAll("code")].map((node) =>
    node.getBoundingClientRect(),
  );
  expect(hash!.left - path!.right).toBeLessThan(16);
  await screen.getByRole("button", { name: "Approve sync" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect
    .element(
      dialog.getByText(new RegExp(`^Fast-forwards qa to the sync head ${head.slice(0, 12)}`)),
    )
    .toBeVisible();
  await expect
    .element(dialog.getByText(/^Fast-forwards.*1 present, 1 changed, 1 missing/))
    .toBeVisible();
  await expect
    .element(dialog.getByText("Hotfix survival report for", { exact: false }))
    .toBeVisible();
  await dialog.getByRole("button", { name: "Approve sync…" }).click();
  await sign();
  expect(mock.acts).toEqual([
    {
      path: `/api/deployments/promotions/${resolved.id}/action`,
      body: { action: "approve", head, by: "Ben", key: "passphrase" },
    },
  ]);
});

it("says so when a refresh reports on a newer sync head, and asks again before approving it", async () => {
  setup(recorded.withHotfix);
  const resolved = sync["resolved"]!;
  const newer = sync["resolvedNewer"]!;
  const newHead = newer.resolution!.head;
  await using screen = await render(<Harness promotion={resolved} />);
  await screen.getByRole("button", { name: "Approve sync" }).click();
  await screen.rerender(<Harness promotion={newer} />);
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog.getByText(/^The sync branch moved/)).toBeVisible();
  await expect
    .element(dialog.getByRole("button", { name: /^Approve sync/ }))
    .not.toBeInTheDocument();
  await dialog.getByRole("button", { name: `Review ${newHead.slice(0, 12)}` }).click();
  await expect
    .element(dialog.getByText(/^Fast-forwards.*3 present, 0 changed, 0 missing/))
    .toBeVisible();
  // The card is behind the modal: the new head's report is shown in the dialog itself.
  await expect
    .element(
      dialog.getByText(`Hotfix survival report for ${newHead.slice(0, 12)}`, { exact: false }),
    )
    .toBeVisible();
  await dialog.getByRole("button", { name: "Approve sync…" }).click();
  await sign();
  expect(mock.acts).toEqual([
    {
      path: `/api/deployments/promotions/${newer.id}/action`,
      body: { action: "approve", head: newHead, by: "Ben", key: "passphrase" },
    },
  ]);
});

it("cancels out of an approval without sending anything", async () => {
  setup(recorded.withHotfix);
  await using screen = await render(<Harness promotion={sync["resolved"]!} />);
  await screen.getByRole("button", { name: "Approve sync" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  expect(mock.acts).toEqual([]);
});

it("in awaiting-merge links the sync PR and says the host must merge it", async () => {
  setup(recorded.withHotfix);
  const waiting = sync["awaiting-merge"]!;
  await using screen = await render(<Harness promotion={waiting} />);
  await expect.element(screen.getByText("Awaiting the host merge")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Sync PR #7" }))
    .toHaveAttribute("href", waiting.syncPr!.url!);
  await expect
    .element(screen.getByText(/^qa is protected, so the engine cannot push the sync/))
    .toBeVisible();
  expect(screen.container.querySelector("[data-promotion-host-merge]")?.textContent).toContain(
    `only the approved head ${waiting.resolution!.approved!.head.slice(0, 12)} is accepted`,
  );
  const buttons = [...screen.container.querySelectorAll("[data-release-promotion] button")].map(
    (node) => node.textContent,
  );
  expect(buttons).toEqual(["Retry", "Cancel promotion"]);
});

it("shows opening as in flight, with nothing to press", async () => {
  setup(recorded.withHotfix);
  await using screen = await render(<Harness promotion={sync["opening"]!} />);
  await expect.element(screen.getByText("Opening the sync PR")).toBeVisible();
  expect(screen.container.querySelectorAll("[data-release-promotion] button")).toHaveLength(0);
});
