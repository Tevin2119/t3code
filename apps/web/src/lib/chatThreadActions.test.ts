import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { carriedModelSelection, resolveNewThreadModelSelectionOverride } from "./chatThreadActions";

const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};
const THREAD_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "glm-5.3",
};
const STALE_PICK: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
};

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });

  it("drops a stale non-explicit pick that disagrees with a started thread's selection", () => {
    expect(carriedModelSelection(true, false, STALE_PICK, THREAD_SELECTION)).toBeUndefined();
  });

  it("carries an explicit pick onto a started thread", () => {
    expect(carriedModelSelection(true, true, STALE_PICK, THREAD_SELECTION)).toEqual(STALE_PICK);
  });

  it("carries a selection that already matches the started thread", () => {
    expect(carriedModelSelection(true, false, THREAD_SELECTION, THREAD_SELECTION)).toEqual(
      THREAD_SELECTION,
    );
  });

  it("carries any selection for a thread that has not started", () => {
    expect(carriedModelSelection(false, false, STALE_PICK, THREAD_SELECTION)).toEqual(STALE_PICK);
  });
});
