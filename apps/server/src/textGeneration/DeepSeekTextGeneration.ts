/**
 * DeepSeek text generation.
 *
 * The structured-output prompts (commit messages, PR content, branch names,
 * thread titles) go straight to `POST /chat/completions`. Unlike every other
 * provider here there is no process, no ACP session and no workspace — the
 * prompt already carries all the context, so `cwd` is unused.
 *
 * `deepseek-chat` is asked for strict JSON through `response_format`;
 * `deepseek-reasoner` rejects that parameter, so its output is parsed out of
 * the prose with the shared extractor instead.
 *
 * @module textGeneration/DeepSeekTextGeneration
 */
import {
  DEEPSEEK_CHAT_MODEL,
  DEEPSEEK_REASONER_MODEL,
  TextGenerationError,
  type DeepSeekSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import {
  deepSeekChatCompletion,
  resolveDeepSeekCredentials,
} from "../provider/deepseek/DeepSeekApi.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const DEEPSEEK_TIMEOUT_MS = 120_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Map whatever the model picker stored onto a real DeepSeek model id. Aliases
 * layered on by other harnesses (Hermes' `deepseek-v4-pro`, for instance) are
 * not ids the API accepts, so anything that looks like a reasoning alias lands
 * on `deepseek-reasoner` and everything else on `deepseek-chat`.
 */
export function resolveDeepSeekModelId(model: string | null | undefined): string {
  const slug = model?.trim().toLowerCase();
  if (!slug) return DEEPSEEK_CHAT_MODEL;
  if (slug === DEEPSEEK_CHAT_MODEL || slug === DEEPSEEK_REASONER_MODEL) return slug;
  return /reason|think|-r\d|pro$/.test(slug) ? DEEPSEEK_REASONER_MODEL : DEEPSEEK_CHAT_MODEL;
}

export const makeDeepSeekTextGeneration = Effect.fn("makeDeepSeekTextGeneration")(function* (
  settings: DeepSeekSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<TextGeneration.TextGeneration["Service"], never, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient;

  const runDeepSeekJson = <S extends Schema.Top>({
    operation,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const credentials = resolveDeepSeekCredentials(settings, environment);
      if (credentials === undefined) {
        return yield* new TextGenerationError({
          operation,
          detail: "No DeepSeek API key is configured. Set one in provider settings.",
        });
      }
      const model = resolveDeepSeekModelId(modelSelection.model);
      const output = yield* deepSeekChatCompletion(credentials, {
        model,
        messages: [{ role: "user", content: prompt }],
        // Only the chat model accepts JSON mode; the reasoner errors on it.
        jsonObject: model === DEEPSEEK_CHAT_MODEL,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.timeoutOrElse({
          duration: DEEPSEEK_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "DeepSeek request timed out." }),
            ),
        }),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({ operation, detail: cause.detail, cause }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(output)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "DeepSeek returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("DeepSeekTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runDeepSeekJson({
        operation: "generateCommitMessage",
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("DeepSeekTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runDeepSeekJson({
        operation: "generatePrContent",
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("DeepSeekTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runDeepSeekJson({
        operation: "generateBranchName",
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("DeepSeekTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runDeepSeekJson({
        operation: "generateThreadTitle",
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
