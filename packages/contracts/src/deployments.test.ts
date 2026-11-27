import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  DeploymentActionInput,
  DeploymentProjectInput,
  DeploymentsSnapshot,
  FirebaseHostingListing,
} from "./deployments.ts";

const isSnapshot = Schema.is(DeploymentsSnapshot);
const decodeSnapshot = Schema.decodeUnknownSync(DeploymentsSnapshot);
const isProjectInput = Schema.is(DeploymentProjectInput);
const isActionInput = Schema.is(DeploymentActionInput);
const decodeListing = Schema.decodeUnknownSync(FirebaseHostingListing);

const commit = "a".repeat(40);
const approval = { by: "Sam", key: "passphrase" };
// The shape engine PR 190 returns for a firebase-hosting instance.
const firebaseProject = {
  id: "payoutlab-main",
  repository: "payoutlab",
  title: "PayoutLab",
  branch: "main",
  environment: "main",
  mode: "manual",
  adapter: "firebase-hosting",
  commands: { qualify: ["node", "scripts/guard.mjs"] },
  firebase: { firebaseProject: "trade-journal-fc3ba", target: "app-payoutlab" },
  latestCommit: commit,
  liveCommit: null,
  liveCandidate: null,
  liveObservedAt: null,
  liveSite: null,
  configuredSite: "app-payoutlab",
  liveAdoptedBy: null,
  liveAdoptedAt: null,
  liveAdoptedCommit: null,
  liveAdoptedSite: null,
  previousLive: null,
  observation: null,
  staleObservation: null,
  problem: null,
  liveProblem:
    "Unverified since the branch head moved to bbbbbbbbbb; the site has not been read since.",
  busy: false,
};
const snapshot = {
  version: 1,
  problem: null,
  projects: [firebaseProject],
  candidates: [],
  repositories: [],
  capabilities: { engine: false, command: true, "firebase-hosting": true },
};

describe("deployment contracts", () => {
  it("decodes a firebase-hosting instance with its live facts exactly as the engine sent them", () => {
    const [project] = decodeSnapshot(snapshot).projects;
    expect(project?.firebase).toEqual(firebaseProject.firebase);
    expect(project?.commands).toEqual({ qualify: ["node", "scripts/guard.mjs"] });
    expect(project?.liveProblem).toBe(firebaseProject.liveProblem);
    expect(project?.configuredSite).toBe("app-payoutlab");
    // An engine from before 190 sends neither the capability nor the Firebase fields.
    const older = {
      ...snapshot,
      projects: [{ ...firebaseProject, adapter: "command", firebase: undefined }],
      capabilities: { engine: false, command: true },
    };
    expect(isSnapshot(older)).toBe(true);
  });

  it("saves a Firebase target only for the firebase-hosting adapter, with no deploy step", () => {
    const base = {
      repository: "payoutlab",
      branch: "main",
      environment: "main",
      mode: "manual",
      adapter: "firebase-hosting",
      firebase: firebaseProject.firebase,
      ...approval,
    };
    expect(isProjectInput(base)).toBe(true);
    expect(isProjectInput({ ...base, commands: { qualify: ["npm", "test"] } })).toBe(true);
    expect(isProjectInput({ ...base, firebase: undefined })).toBe(false);
    expect(isProjectInput({ ...base, adapter: "command" })).toBe(false);
    expect(
      isProjectInput({
        ...base,
        commands: { qualify: ["npm", "test"], deploy: ["firebase", "deploy"], verify: ["x"] },
      }),
    ).toBe(false);
    for (const firebase of [
      { firebaseProject: "trade-journal-fc3ba", target: "hosting:app" },
      { firebaseProject: "trade-journal-fc3ba", target: "app,qa" },
      { firebaseProject: "Bad", target: "app" },
    ]) {
      expect(isProjectInput({ ...base, firebase })).toBe(false);
    }
    // The command adapter still needs all three of its steps.
    expect(
      isProjectInput({
        ...base,
        adapter: "command",
        firebase: undefined,
        commands: { qualify: ["npm", "test"] },
      }),
    ).toBe(false);
  });

  it("adopts with an exact commit or none, and takes a commit for no other action", () => {
    expect(isActionInput({ action: "adopt", ...approval })).toBe(true);
    expect(isActionInput({ action: "adopt", commit, ...approval })).toBe(true);
    expect(isActionInput({ action: "adopt", commit: "main", ...approval })).toBe(false);
    expect(isActionInput({ action: "deploy", commit, ...approval })).toBe(false);
  });

  it("decodes the engine's hosting target listing", () => {
    const listing = decodeListing({
      repository: "payoutlab",
      branch: "qa",
      commit,
      aliases: { default: "trade-journal-fc3ba" },
      targets: [
        {
          firebaseProject: "trade-journal-fc3ba",
          target: "payoutlab-sandbox",
          sites: ["payoutlab-sandbox"],
          site: "payoutlab-sandbox",
          servedFolder: "sandbox",
          hooks: [],
          problem: null,
        },
      ],
      problems: [],
    });
    expect(listing.targets[0]?.servedFolder).toBe("sandbox");
  });
});
