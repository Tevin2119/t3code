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

export const attributedCodexUsageReader: ProviderUsageReader<CodexSettings, Path.Path> = withFormat(
  codexUsageReader,
  attributedCodexUsageFormat as TranscriptUsageFormat<unknown>,
);
