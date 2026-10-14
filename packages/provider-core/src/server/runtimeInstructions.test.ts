import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { clearDeliveryThreadSession, setDeliveryThreadSession } from "./deliveryThreadSession.ts";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it.each(["OpenCode", "Pi", "Kimi", "Hermes", "DeepSeek", "Antigravity"])(
    "keeps %s team instructions thread-scoped and reflects updated seeding",
    (harness) => {
      const threadId = ThreadId.make(`seed-${harness}`);
      const otherThreadId = ThreadId.make(`other-${harness}`);
      const session = {
        threadId,
        team: "ilm",
        role: "reviewer",
        configuration: "revision-1",
        instructions: "Review all four assignment variants.",
        servers: {},
      };
      try {
        setDeliveryThreadSession(session);
        expect(buildRuntimeInstructions({ harness, threadId })).toContain(session.instructions);
        expect(buildRuntimeInstructions({ harness, threadId: otherThreadId })).not.toContain(
          session.instructions,
        );
        setDeliveryThreadSession({ ...session, instructions: "Review the revised drafts." });
        expect(buildRuntimeInstructions({ harness, threadId })).toContain(
          "Review the revised drafts.",
        );
        expect(buildRuntimeInstructions({ harness, threadId })).not.toContain(session.instructions);
      } finally {
        clearDeliveryThreadSession(threadId);
      }
      expect(buildRuntimeInstructions({ harness, threadId })).not.toContain("team_instructions");
    },
  );
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});
