import type { DeploymentCompare } from "@t3tools/contracts";

export const SANDBOX_A = "a".repeat(40);
export const SANDBOX_B = "b".repeat(40);
export const SANDBOX_PORTED = "d".repeat(40);
export const APP_FIX = "c".repeat(40);

const empty = { prs: [], loose: [], tasks: [], count: 0, truncated: false };

/** qa (serves sandbox/) ahead of app (serves app/): two unported sandbox commits, one ported. */
export const compareWithPorts: DeploymentCompare = {
  version: 1,
  repository: "payoutlab",
  from: { id: "payoutlab-qa", environment: "qa", branch: "qa", servedFolder: "sandbox" },
  to: { id: "payoutlab-app", environment: "app", branch: "main", servedFolder: "app" },
  points: { fromLive: SANDBOX_A, toLive: null, fromTip: SANDBOX_A, toTip: null },
  limit: 500,
  ahead: {
    prs: [
      {
        number: 129,
        url: null,
        title: "feat: sandbox payout",
        commit: SANDBOX_B,
        kind: "feature",
        source: "merge-subject",
        task: null,
        run: null,
      },
      {
        number: 127,
        url: null,
        title: "fix: rounding in totals",
        commit: APP_FIX,
        kind: "fix",
        source: "squash-subject",
        task: null,
        run: null,
      },
    ],
    loose: [
      { commit: SANDBOX_A, subject: "style(sandbox): payout colours" },
      { commit: SANDBOX_PORTED, subject: "feat(sandbox): preview page" },
    ],
    tasks: [],
    count: 4,
    truncated: false,
    ports: [
      {
        commit: SANDBOX_PORTED,
        task: "task-9",
        number: 9,
        title: "Port to app: 1 sandbox commit",
        state: "draft",
        by: "Sam",
        filed: "2026-11-27T10:00:00.000Z",
      },
    ],
  },
  hotfixes: empty,
  waiting: empty,
  folders: {
    to: "app",
    from: "sandbox",
    touchesTo: 1,
    onlyFrom: 3,
    untouched: 3,
    commits: { touchesTo: [APP_FIX], onlyFrom: [SANDBOX_A, SANDBOX_B, SANDBOX_PORTED] },
    truncated: false,
    text: null,
  },
  promote: "promote",
  problem: null,
};
