import type { DeploymentCandidate, FirebaseHostingListing } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  ADOPT_UNKNOWN,
  adapterLabel,
  adoptChoices,
  firebaseFromValue,
  firebaseListingPath,
  firebaseTargetChoices,
  firebaseTargetValue,
  parseFirebaseListing,
} from "./FirebaseHosting.logic";

const row = (changes: Partial<FirebaseHostingListing["targets"][number]> = {}) => ({
  firebaseProject: "trade-journal-fc3ba",
  target: "app-payoutlab",
  sites: ["app-payoutlab"],
  site: "app-payoutlab",
  servedFolder: "app",
  hooks: [],
  problem: null,
  ...changes,
});
const listing = (targets: ReturnType<typeof row>[]): FirebaseHostingListing => ({
  repository: "payoutlab",
  branch: "main",
  commit: "a".repeat(40),
  aliases: {},
  targets,
  problems: [],
});
const candidate = (changes: Partial<DeploymentCandidate> = {}): DeploymentCandidate => ({
  id: "c2",
  projectId: "p",
  commit: "c".repeat(40),
  baseCommit: "b".repeat(40),
  state: "ready",
  createdAt: "2026-11-26T00:00:00Z",
  updatedAt: "2026-11-26T00:00:00Z",
  evidence: { passed: true, site: "app-payoutlab" },
  events: [],
  ...changes,
});

describe("Firebase Hosting setup", () => {
  it("reads a branch's targets by an encoded path the delivery relay accepts", () => {
    expect(firebaseListingPath("payoutlab", "release/qa")).toBe(
      "/api/repositories/payoutlab/firebase?branch=release%2Fqa",
    );
  });

  it("offers only targets the engine resolved and keeps its reasons for the rest", () => {
    const choices = firebaseTargetChoices(
      listing([
        row(),
        row({ target: "sandbox", site: null, problem: "firebase.json has a predeploy hook." }),
      ]),
    );
    expect(choices.items).toEqual([
      {
        value: "trade-journal-fc3ba:app-payoutlab",
        label: "app-payoutlab · trade-journal-fc3ba → app-payoutlab, serves app/",
      },
    ]);
    expect(choices.refused).toEqual([
      { label: "sandbox · trade-journal-fc3ba", problem: "firebase.json has a predeploy hook." },
    ]);
  });

  it("round-trips a chosen target and refuses anything else", () => {
    const firebase = { firebaseProject: "trade-journal-fc3ba", target: "app-payoutlab" };
    expect(firebaseFromValue(firebaseTargetValue(firebase))).toEqual(firebase);
    for (const value of ["", "only", "a:b:c"]) expect(firebaseFromValue(value)).toBeNull();
  });

  it("rejects a listing an older engine could not have meant", () => {
    expect(parseFirebaseListing({ error: "not found" })).toBeNull();
    expect(parseFirebaseListing(listing([row()]))?.targets).toHaveLength(1);
  });

  it("adopts unknown first, then commits the engine knows, never the candidate's own", () => {
    const own = candidate();
    const older = candidate({ id: "c1", commit: "d".repeat(40), subject: "Fix login", seq: 1 });
    const sameCommit = candidate({ id: "c0", commit: own.commit });
    const elsewhere = candidate({ id: "x", projectId: "other", commit: "e".repeat(40) });
    expect(adoptChoices(own, [own, older, sameCommit, elsewhere])).toEqual([
      { value: ADOPT_UNKNOWN, label: "Unknown, accept once" },
      { value: "b".repeat(40), label: "bbbbbbbbbb · this release's base" },
      { value: "d".repeat(40), label: "dddddddddd · Fix login" },
    ]);
  });

  it("names the adapter with its saved target", () => {
    expect(
      adapterLabel({
        adapter: "firebase-hosting",
        firebase: { firebaseProject: "trade-journal-fc3ba", target: "app-payoutlab" },
      }),
    ).toBe("Firebase Hosting · app-payoutlab · trade-journal-fc3ba");
    expect(adapterLabel({ adapter: "command" })).toBe("Repository commands");
  });
});
