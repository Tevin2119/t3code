import { describe, expect, it } from "vite-plus/test";

import { portDraft } from "./deploymentPort.ts";
import {
  APP_FIX,
  SANDBOX_A,
  SANDBOX_B,
  SANDBOX_PORTED,
  compareWithPorts,
} from "./deploymentPort.fixture.ts";

describe("portDraft", () => {
  it("names the repository, both instances and each commit with its subject, newest first", () => {
    const result = portDraft(compareWithPorts, [SANDBOX_B, SANDBOX_A, SANDBOX_B]);
    if (!result.ok) throw new Error(result.why);
    expect(result.draft.commits).toEqual([SANDBOX_A, SANDBOX_B]);
    expect(result.draft.title).toBe("Port to app: 2 sandbox commits");
    expect(result.draft.body).toContain("- Repository: payoutlab");
    expect(result.draft.body).toContain("- From: qa (payoutlab-qa, branch qa, serves sandbox/)");
    expect(result.draft.body).toContain("- To: app (payoutlab-app, branch main, serves app/)");
    expect(result.draft.body).toContain(
      `## Commits\n\n- ${SANDBOX_A} style(sandbox): payout colours\n- ${SANDBOX_B} #129 feat: sandbox payout\n`,
    );
    expect(result.draft.body).toContain(
      "One pull request into qa brings the same change into app/",
    );
    // The same request composes the same draft, so the engine replays it instead of conflicting.
    expect(portDraft(compareWithPorts, [SANDBOX_A, SANDBOX_B])).toEqual(result);
  });

  it("refuses a commit that changes what app serves, or one that already has a port", () => {
    expect(portDraft(compareWithPorts, [APP_FIX])).toEqual({
      ok: false,
      why: "ccccccc is not a commit that changes only sandbox/ on qa.",
    });
    expect(portDraft(compareWithPorts, [SANDBOX_A, SANDBOX_PORTED])).toEqual({
      ok: false,
      why: "ddddddd already has a Port to app task #9.",
    });
  });

  it("refuses while the folder split is unknown", () => {
    const unknown = {
      ...compareWithPorts,
      folders: { ...compareWithPorts.folders!, unknown: true },
    };
    expect(portDraft(unknown, [SANDBOX_A]).ok).toBe(false);
    const { commits: _commits, ...withoutCommits } = compareWithPorts.folders!;
    const older = { ...compareWithPorts, folders: withoutCommits };
    expect(portDraft(older, [SANDBOX_A]).ok).toBe(false);
  });
});
