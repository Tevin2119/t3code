/**
 * DeepSeek adapter — deliberately inert.
 *
 * `ProviderInstance` requires an adapter, but DeepSeek has no session protocol:
 * it is an OpenAI-compatible chat API with no tool calls, no sandbox and no
 * filesystem access, so there is nothing for a thread to run against. The
 * driver's real surface is its `textGeneration` service.
 *
 * Clients already keep the provider out of the chat model picker via
 * `supportsSessions: false` on the snapshot. This adapter is the server-side
 * half of the same statement: any request that would start or drive a thread
 * fails with an explanation instead of half-working.
 *
 * @module provider/Layers/DeepSeekAdapter
 */
import { ProviderDriverKind, type ProviderSession } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("deepseek");

const UNSUPPORTED_DETAIL =
  "DeepSeek is an API-only provider in T3 Code and cannot run threads. Use it for text generation, or pick a CLI provider for this thread.";

const unsupported = (method: string) =>
  Effect.fail(
    new ProviderAdapterRequestError({ provider: PROVIDER, method, detail: UNSUPPORTED_DETAIL }),
  );

export function makeDeepSeekAdapter(): ProviderAdapterShape<ProviderAdapterError> {
  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "unsupported",
      supportsConversationRollback: false,
    },
    startSession: () => unsupported("startSession"),
    sendTurn: () => unsupported("sendTurn"),
    interruptTurn: () => unsupported("interruptTurn"),
    respondToRequest: () => unsupported("respondToRequest"),
    respondToUserInput: () => unsupported("respondToUserInput"),
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([] as ReadonlyArray<ProviderSession>),
    hasSession: () => Effect.succeed(false),
    readThread: () => unsupported("readThread"),
    rollbackThread: () => unsupported("rollbackThread"),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  };
}
