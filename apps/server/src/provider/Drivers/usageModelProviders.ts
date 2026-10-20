/**
 * The fork's model-provider attribution for upstream's Claude and Codex usage
 * readers, kept out of their formats so those stay as upstream wrote them.
 *
 * Claude Code records no provider and, on this environment, calls only
 * Anthropic. Codex records the provider of a rollout in its first
 * `session_meta` (`model_provider`), which this carries in the reducer state.
 *
 * @module provider/Drivers/usageModelProviders
 */
import type { ClaudeSettings, CodexSettings } from "@t3tools/contracts";
import type {
  ProviderUsageReader,
  SelectedFields,
  TranscriptUsageFormat,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as CodexUsageHistory from "../../usage/CodexUsageHistory.ts";

import { piUsageFormat, piUsageReader } from "@t3tools/provider-pi/server/usage";

import { claudeUsageFormat, claudeUsageReader } from "./claudeUsage.ts";
import {
  CodexScanState,
  codexUsageFormat,
  codexUsageReader,
  initialCodexScanState,
} from "./codexUsage.ts";

function withFormat<Config, R>(
  reader: ProviderUsageReader<Config, R>,
  format: TranscriptUsageFormat<unknown>,
): ProviderUsageReader<Config, R> {
  return reader.kind === "transcripts" ? { ...reader, format } : reader;
}

const ANTHROPIC = { modelProvider: "anthropic", modelProviderSource: "harness" } as const;

export const attributedClaudeUsageFormat: TranscriptUsageFormat<void> = {
  ...claudeUsageFormat,
  parseLine: (line, state) =>
    claudeUsageFormat.parseLine(line, state).map((record) => ({ ...record, ...ANTHROPIC })),
  parseProjected: (projected, state) =>
    claudeUsageFormat
      .parseProjected(projected, state)
      .map((record) => ({ ...record, ...ANTHROPIC })),
};

/** Codex's reducer state, with the `model_provider` of the rollout's own `session_meta`. */
export const AttributedCodexScanState = Schema.Struct({
  ...CodexScanState.fields,
  /** Empty until the rollout's `session_meta` is seen, or when it names none. */
  modelProvider: Schema.mutableKey(Schema.String),
});
export type AttributedCodexScanState = typeof AttributedCodexScanState.Type;

/** Reads `model_provider` from the first `session_meta`, before Codex's reducer marks it seen. */
function noteModelProvider(parsed: unknown, state: AttributedCodexScanState): void {
  if (state.sawSessionMeta || typeof parsed !== "object" || parsed === null) return;
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "session_meta") return;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return;
  const modelProvider = (payload as Record<string, unknown>)["model_provider"];
  if (typeof modelProvider === "string") state.modelProvider = modelProvider;
}

function attributeCodex(
  records: readonly UsageRecord[],
  state: AttributedCodexScanState,
): readonly UsageRecord[] {
  if (records.length === 0) return records;
  const known = state.modelProvider.length > 0;
  return records.map((record) => ({
    ...record,
    modelProvider: known ? state.modelProvider : null,
    modelProviderSource: known ? "recorded" : null,
  }));
}

const codexPayloadFields = codexUsageFormat.selectFields["payload"];

export const attributedCodexUsageFormat: TranscriptUsageFormat<AttributedCodexScanState> = {
  ...codexUsageFormat,
  selectFields: {
    ...codexUsageFormat.selectFields,
    payload: {
      ...(typeof codexPayloadFields === "object" ? codexPayloadFields : {}),
      model_provider: true,
    } satisfies SelectedFields,
  },
  parseLine: (line, state) => {
    if (!state.sawSessionMeta && line.includes('"session_meta"')) {
      try {
        noteModelProvider(JSON.parse(line), state);
      } catch {
        // Codex's own parse skips the same line.
      }
    }
    return attributeCodex(codexUsageFormat.parseLine(line, state), state);
  },
  parseProjected: (projected, state) => {
    noteModelProvider(projected, state);
    return attributeCodex(codexUsageFormat.parseProjected(projected, state), state);
  },
  state: {
    initial: () => ({ ...initialCodexScanState(), modelProvider: "" }),
    schema: AttributedCodexScanState,
  },
};

export const attributedClaudeUsageReader: ProviderUsageReader<ClaudeSettings, Path.Path> =
  withFormat(claudeUsageReader, attributedClaudeUsageFormat as TranscriptUsageFormat<unknown>);

export const attributedCodexUsageReader: ProviderUsageReader<
  CodexSettings,
  Path.Path | CodexUsageHistory.CodexUsageHistory
> = withFormat(codexUsageReader, attributedCodexUsageFormat as TranscriptUsageFormat<unknown>);

/**
 * Pi records the provider of each model it called ("openai-codex/gpt-6-luna"). Its tool and
 * summary records name none.
 */
function attributePi(records: readonly UsageRecord[]): readonly UsageRecord[] {
  return records.map((record) => {
    const slash = record.model.indexOf("/");
    const known = slash > 0 && record.model !== "Tools/summaries";
    return {
      ...record,
      modelProvider: known ? record.model.slice(0, slash) : null,
      modelProviderSource: known ? "recorded" : null,
    };
  });
}

export const attributedPiUsageFormat: TranscriptUsageFormat<{ sessionId: string }> = {
  ...piUsageFormat,
  parseLine: (line, state) => attributePi(piUsageFormat.parseLine(line, state)),
  parseProjected: (projected, state) => attributePi(piUsageFormat.parseProjected(projected, state)),
};

export const attributedPiUsageReader: typeof piUsageReader = withFormat(
  piUsageReader,
  attributedPiUsageFormat as TranscriptUsageFormat<unknown>,
);
