/**
 * pi text generation.
 *
 * pi has no ACP server, so the short structured-output prompts run through its
 * non-interactive mode (`pi -p`) and the JSON object is extracted from stdout.
 * Tools are disabled for these calls: they are pure completions over context
 * the server already gathered, and a tool-enabled run would touch the workspace.
 *
 * Model patterns are always passed fully qualified (`provider/id`). pi accepts
 * bare patterns too, but resolving them fuzzily costs several extra seconds per
 * call.
 *
 * @module textGeneration/PiTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { TextGenerationError, type ModelSelection, type PiSettings } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "../provider/providerSnapshot.ts";
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

const PI_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Build the argument list for one non-interactive completion. `--` terminates
 * option parsing so a prompt beginning with a dash is still read as a message.
 */
export function buildPiTextGenerationArgs(input: {
  readonly provider: string;
  readonly model: string | undefined;
  readonly prompt: string;
}): ReadonlyArray<string> {
  return [
    "--print",
    "--no-tools",
    "--no-session",
    "--provider",
    input.provider,
    ...(input.model ? ["--model", input.model] : []),
    "--",
    input.prompt,
  ];
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const command = piSettings.binaryPath || "pi";
      const args = buildPiTextGenerationArgs({
        provider: piSettings.provider.trim() || "kimi-coding",
        model: modelSelection.model?.trim() || undefined,
        prompt,
      });
      const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({ operation, detail: "Could not resolve the pi CLI.", cause }),
        ),
      );
      const outcome = yield* spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd,
          env: environment,
          shell: spawnCommand.shell,
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
        Effect.timeoutOption(PI_TIMEOUT_MS),
        Effect.result,
        Effect.flatMap((result) =>
          Result.isFailure(result)
            ? Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "pi text generation failed to run.",
                  cause: result.failure,
                }),
              )
            : Option.match(result.success, {
                onNone: () =>
                  Effect.fail(
                    new TextGenerationError({ operation, detail: "pi request timed out." }),
                  ),
                onSome: (value) => Effect.succeed(value),
              }),
        ),
      );

      if (outcome.code !== 0) {
        return yield* new TextGenerationError({
          operation,
          detail: `pi exited with status ${outcome.code}.`,
        });
      }
      const trimmed = outcome.stdout.trim();
      if (!trimmed) {
        return yield* new TextGenerationError({ operation, detail: "pi returned empty output." });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "pi returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({ operation, detail: "pi text generation failed.", cause }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
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
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
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
