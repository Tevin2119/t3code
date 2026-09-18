/**
 * DeepSeek HTTP client.
 *
 * DeepSeek ships no coding CLI — it is a raw OpenAI-compatible API — so this is
 * the whole transport for the driver: no process to spawn, no ACP, no session
 * protocol. Everything the provider does is one `POST /chat/completions` or one
 * `GET /models`.
 *
 * The key is never logged, never placed in a URL, and never copied into a
 * snapshot. It is held as `Redacted` from the moment it is read so an
 * accidental interpolation prints a placeholder instead of the credential.
 *
 * @module provider/deepseek/DeepSeekApi
 */
import { DEEPSEEK_DEFAULT_BASE_URL, type DeepSeekSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export class DeepSeekApiError extends Schema.TaggedError<DeepSeekApiError>()("DeepSeekApiError", {
  operation: Schema.String,
  detail: Schema.String,
  status: Schema.optional(Schema.Finite),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface DeepSeekCredentials {
  readonly apiKey: Redacted.Redacted;
  readonly baseUrl: string;
}

/**
 * Settings key first, `DEEPSEEK_API_KEY` second. Returning `undefined` rather
 * than failing lets the snapshot report "not configured" as a status instead of
 * an error, which is how every other provider reports a missing credential.
 */
export function resolveDeepSeekCredentials(
  settings: Pick<DeepSeekSettings, "apiKey" | "baseUrl">,
  environment: NodeJS.ProcessEnv,
): DeepSeekCredentials | undefined {
  const key = settings.apiKey.trim() || (environment["DEEPSEEK_API_KEY"] ?? "").trim();
  if (key.length === 0) return undefined;
  const baseUrl = (settings.baseUrl.trim() || DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { apiKey: Redacted.make(key), baseUrl };
}

const ModelListResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const ChatCompletionResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.optional(Schema.NullOr(Schema.String)),
        reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

export interface DeepSeekMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface DeepSeekChatInput {
  readonly model: string;
  readonly messages: ReadonlyArray<DeepSeekMessage>;
  /**
   * Ask for strict JSON. Only `deepseek-chat` honours it; `deepseek-reasoner`
   * rejects the parameter, so callers leave it off for reasoning models and
   * rely on extracting the object from the prose instead.
   */
  readonly jsonObject?: boolean | undefined;
  readonly maxTokens?: number | undefined;
}

const authorized = (
  credentials: DeepSeekCredentials,
  request: HttpClientRequest.HttpClientRequest,
) => request.pipe(HttpClientRequest.bearerToken(Redacted.value(credentials.apiKey)));

/**
 * Turn a transport or status failure into a message that is safe to show. The
 * response body is deliberately not echoed: DeepSeek reflects request content
 * in some errors, and that content is the user's diff.
 */
const failureDetail = (operation: string, status: number): string => {
  if (status === 401 || status === 403) {
    return "DeepSeek rejected the API key. Check the key in provider settings.";
  }
  if (status === 402) return "The DeepSeek account has insufficient balance.";
  if (status === 429) return "DeepSeek is rate limiting this key. Try again shortly.";
  if (status >= 500) return "DeepSeek is unavailable. Try again shortly.";
  return `DeepSeek ${operation} failed with status ${status}.`;
};

/** List the model ids the key can reach. Doubles as the credential probe. */
export const listDeepSeekModels = Effect.fn("listDeepSeekModels")(function* (
  credentials: DeepSeekCredentials,
): Effect.fn.Return<ReadonlyArray<string>, DeepSeekApiError, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* httpClient
    .execute(authorized(credentials, HttpClientRequest.get(`${credentials.baseUrl}/models`)))
    .pipe(
      Effect.mapError(
        (cause) =>
          new DeepSeekApiError({
            operation: "models",
            detail: "Could not reach the DeepSeek API.",
            cause,
          }),
      ),
    );
  if (response.status !== 200) {
    return yield* new DeepSeekApiError({
      operation: "models",
      detail: failureDetail("model list", response.status),
      status: response.status,
    });
  }
  const body = yield* HttpClientResponse.schemaBodyJson(ModelListResponse)(response).pipe(
    Effect.mapError(
      (cause) =>
        new DeepSeekApiError({
          operation: "models",
          detail: "DeepSeek returned an unexpected model list.",
          cause,
        }),
    ),
  );
  return body.data.map((model) => model.id);
});

/** One non-streaming completion. Returns the assistant text, never the reasoning trace. */
export const deepSeekChatCompletion = Effect.fn("deepSeekChatCompletion")(function* (
  credentials: DeepSeekCredentials,
  input: DeepSeekChatInput,
): Effect.fn.Return<string, DeepSeekApiError, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient;
  const request = yield* HttpClientRequest.post(`${credentials.baseUrl}/chat/completions`).pipe(
    HttpClientRequest.bodyJson({
      model: input.model,
      messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
      stream: false,
      ...(input.jsonObject ? { response_format: { type: "json_object" } } : {}),
      ...(input.maxTokens === undefined ? {} : { max_tokens: input.maxTokens }),
    }),
    Effect.mapError(
      (cause) =>
        new DeepSeekApiError({
          operation: "chat",
          detail: "Could not encode the DeepSeek request.",
          cause,
        }),
    ),
  );
  const response = yield* httpClient.execute(authorized(credentials, request)).pipe(
    Effect.mapError(
      (cause) =>
        new DeepSeekApiError({
          operation: "chat",
          detail: "Could not reach the DeepSeek API.",
          cause,
        }),
    ),
  );
  if (response.status !== 200) {
    return yield* new DeepSeekApiError({
      operation: "chat",
      detail: failureDetail("request", response.status),
      status: response.status,
    });
  }
  const body = yield* HttpClientResponse.schemaBodyJson(ChatCompletionResponse)(response).pipe(
    Effect.mapError(
      (cause) =>
        new DeepSeekApiError({
          operation: "chat",
          detail: "DeepSeek returned an unexpected response.",
          cause,
        }),
    ),
  );
  const content = body.choices[0]?.message.content?.trim() ?? "";
  if (content.length === 0) {
    return yield* new DeepSeekApiError({
      operation: "chat",
      detail: "DeepSeek returned empty output.",
    });
  }
  return content;
});
