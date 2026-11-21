import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { parseCard, type DeliveryCard } from "../../lib/delivery";
import { CardDeliveryStatus } from "./CardDeliveryStatus";
import { BOARD_DIAGNOSTICS, DeliveryDiagnosticNotice } from "./DeliveryDiagnosticNotice";

vi.mock("gt-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react")>()),
  useGT:
    () =>
    (text: string, vars: Record<string, string> = {}) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? ""),
}));
vi.mock("../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("../../browser/useOpenLink", () => ({ useOpenLink: () => vi.fn(async () => {}) }));
vi.mock("./TaskDeploymentStatus", () => ({
  TaskDeploymentBadge: () => <span data-task-deployment-badge />,
}));

const pr = { number: 42, url: "https://github.com/owner/app/pull/42" };
const offPolicy = {
  setting: "inherit",
  requestedBy: null,
  requestedSince: null,
  resolved: "off",
  eligible: false,
  source: "board",
  sourceId: "work",
  by: "Sam",
  since: "2030-01-01T00:00:00.000Z",
  board: "work",
  mode: "manual",
  problem: null,
  blockingReason: "permission-off",
  execution: "guarded",
};
const publication = (fields: Record<string, unknown> = {}) => ({
  state: "pr-open",
  branch: "b",
  commit: "a".repeat(40),
  pullRequest: pr,
  error: null,
  attempts: 1,
  ...fields,
});
const project = {
  id: "deploy-1",
  repository: "app",
  path: "/real/app",
  environment: "staging",
  branch: "main",
  mode: "manual",
  title: "App",
};
const liveDeployment = {
  current: {
    publication: "p",
    run: "run-1",
    task: "task-7",
    board: "work",
    projectId: project.id,
    repositoryPath: "/real/app",
    targetBranch: "main",
    project,
    headCommit: "a".repeat(40),
    pullRequest: pr,
    publicationState: "merged",
    mergeCommit: "c".repeat(40),
    state: "live",
    problem: null,
    candidate: {
      id: "cand",
      commit: "c".repeat(40),
      branch: "main",
      state: "live",
      inclusion: "ancestor",
      evidence: {},
      problem: null,
      failedPhase: null,
      liveAt: "2030-01-01T00:00:00.000Z",
      liveUntil: null,
    },
    history: [],
    updated: "2030-01-01T00:00:00.000Z",
  },
  history: [],
};
const card = (fields: Record<string, unknown>): DeliveryCard =>
  parseCard({ id: "task-7", run: { id: "run-1" }, ...fields } as never);

function render(node: React.ReactElement) {
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(node);
  });
  return renderer;
}
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
const fact = (root: ReactTestInstance, kind: string) =>
  root.find((node) => node.props["data-card-delivery-fact"] === kind);
const buttons = (root: ReactTestInstance) =>
  root.findAll((node) => node.type === "button" || node.props.role === "button");

// One row per card state of BOARD-REVAMP-UI-SPEC section 3.
const STATES: ReadonlyArray<[string, Record<string, unknown>, string, RegExp]> = [
  [
    "pull request open",
    { publication: publication() },
    "pull-request",
    /Pull request open.*PR #42/,
  ],
  [
    "merged",
    { publication: publication({ state: "merged", mergeCommit: "f".repeat(40) }) },
    "merged",
    /^Merged/,
  ],
  [
    "deployed",
    { publication: publication({ state: "merged" }), deployment: liveDeployment },
    "deployed",
    /Deployed.*App · staging/,
  ],
  [
    "merge permission off",
    { publication: publication(), mergePermission: offPolicy },
    "merge-off",
    /Automatic merge off.*set on board work/,
  ],
  [
    "merge permission on, not eligible",
    {
      publication: publication(),
      mergePermission: { ...offPolicy, resolved: "on", blockingReason: "full-auto-required" },
    },
    "merge-not-eligible",
    /not eligible.*full-auto-required/,
  ],
  [
    "merge in progress",
    { publication: publication({ mergeExecution: { state: "intent", reason: null } }) },
    "merge-in-progress",
    /Merge in progress.*intent/,
  ],
  [
    "merge failed",
    {
      publication: publication({
        mergeExecution: { state: "blocked", reason: "approval-does-not-stand" },
      }),
    },
    "merge-failed",
    /Merge blocked.*blocked: approval-does-not-stand/,
  ],
  [
    "merge uncertain",
    {
      publication: publication({
        mergeExecution: { state: "uncertain", reason: "intent-not-proven-merged-no-retry" },
      }),
    },
    "merge-uncertain",
    /uncertain.*uncertain: intent-not-proven-merged-no-retry/,
  ],
];

describe("CardDeliveryStatus", () => {
  it("no publication: renders nothing at all", () => {
    const renderer = render(<CardDeliveryStatus card={card({})} variant="card" />);
    expect(renderer.toJSON()).toBeNull();
  });

  it.each(STATES)("%s", (_, fields, kind, words) => {
    const root = render(<CardDeliveryStatus card={card(fields)} variant="card" />).root;
    expect(text(fact(root, kind))).toMatch(words);
  });

  it("shows no action in any state: actions come only from the card's actions list", () => {
    for (const [, fields] of STATES)
      for (const variant of ["card", "panel"] as const) {
        const root = render(
          <CardDeliveryStatus card={card({ ...fields, actions: ["publish"] })} variant={variant} />,
        ).root;
        expect(buttons(root)).toEqual([]);
      }
  });

  it("links the pull request without opening the card", () => {
    const root = render(
      <CardDeliveryStatus card={card({ publication: publication() })} variant="card" />,
    ).root;
    const link = root.find((node) => node.props["data-card-delivery-pr"] === true);
    expect(link.props.href).toBe(pr.url);
    const stopPropagation = vi.fn();
    link.props.onClick({ stopPropagation, preventDefault: vi.fn(), button: 0 });
    expect(stopPropagation).toHaveBeenCalled();
  });

  it("merged without a reported merge commit says so rather than showing the PR head", () => {
    const root = render(
      <CardDeliveryStatus
        card={card({ publication: publication({ state: "merged" }) })}
        variant="card"
      />,
    ).root;
    expect(text(fact(root, "merged"))).toContain("The host has not reported a merge commit.");
    expect(text(fact(root, "merged"))).not.toContain("a".repeat(12));
  });

  it("deployed: preview, logs and deployment id appear only when the engine sends them", () => {
    const bare = render(
      <CardDeliveryStatus card={card({ deployment: liveDeployment })} variant="card" />,
    ).root;
    expect(fact(bare, "deployed").findAllByType("a")).toEqual([]);
    const current = {
      ...liveDeployment.current,
      previewUrl: "https://preview.example",
      logsUrl: "https://logs.example",
      deploymentId: "dep-9",
    };
    const reported = render(
      <CardDeliveryStatus card={card({ deployment: { current, history: [] } })} variant="card" />,
    ).root;
    const links = fact(reported, "deployed")
      .findAllByType("a")
      .map((link) => link.props.href);
    expect(links).toEqual(["https://preview.example", "https://logs.example"]);
    expect(text(fact(reported, "deployed"))).toContain("dep-9");
  });

  it("on a card, merge permission waits for an open pull request; the panel always says it", () => {
    const fields = { mergePermission: offPolicy };
    expect(render(<CardDeliveryStatus card={card(fields)} variant="card" />).toJSON()).toBeNull();
    const panel = render(<CardDeliveryStatus card={card(fields)} variant="panel" />).root;
    expect(text(fact(panel, "merge-off"))).toMatch(/Automatic merge off/);
  });

  it("fallback says nothing was set", () => {
    const root = render(
      <CardDeliveryStatus
        card={card({ mergePermission: { ...offPolicy, source: "fallback", sourceId: null } })}
        variant="panel"
      />,
    ).root;
    expect(text(fact(root, "merge-off"))).toContain("nothing set, so off by default");
  });
});

describe("DeliveryDiagnosticNotice", () => {
  it("gives every board diagnostic its own words, with the engine's problem unchanged", () => {
    const titles = BOARD_DIAGNOSTICS.map((code) => {
      const root = render(<DeliveryDiagnosticNotice code={code} problem="Engine said: x." />).root;
      const notice = root.find((node) => node.props["data-delivery-diagnostic"] === code);
      expect(text(notice)).toContain("Engine said: x.");
      return text(notice.findAllByType("p")[0]!);
    });
    expect(new Set(titles).size).toBe(BOARD_DIAGNOSTICS.length);
  });
});
