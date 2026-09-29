import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  confirmedBySession,
  patchFromRuntimeEvent,
  requestedOf,
  withPatch,
  type EffectiveReport,
} from "./DeliveryEffective.ts";

const selection = (
  instance: string,
  model: string,
  options: ReadonlyArray<{ id: string; value: string }> = [],
): ModelSelection =>
  ({
    instanceId: ProviderInstanceId.make(instance),
    model,
    ...(options.length > 0 ? { options } : {}),
  }) as ModelSelection;

const configured = (provider: string, config: Record<string, unknown>): ProviderRuntimeEvent =>
  ({
    type: "session.configured",
    eventId: EventId.make("event-1"),
    provider: ProviderDriverKind.make(provider),
    createdAt: "2026-09-29T00:00:00.000Z",
    threadId: ThreadId.make("thread-1"),
    payload: { config },
  }) as ProviderRuntimeEvent;

const EMPTY: EffectiveReport = {
  reason: "the session was started",
  requested: {},
  passed: {},
  confirmed: {},
  confirmedBy: {},
  notApplied: [],
};

describe("requestedOf", () => {
  it("reads the level from the option of the driver, and the access from the mode", () => {
    expect(
      requestedOf({
        driver: "codex",
        modelSelection: selection("codex", "gpt-6-luna", [
          { id: "reasoningEffort", value: "high" },
        ]),
        runtimeMode: "full-access",
      }),
    ).toEqual({
      harness: "codex",
      model: "gpt-6-luna",
      reasoning: "high",
      access: "full",
      runtimeMode: "full-access",
    });
  });

  it("takes the harness default for no choice of a level, and a mode that asks for no access of a seat", () => {
    expect(
      requestedOf({
        driver: "deepseek",
        modelSelection: selection("deepseek", "deepseek-v4-pro", [
          { id: "reasoning_effort", value: "harness-default" },
        ]),
        runtimeMode: "approval-required",
      }),
    ).toEqual({
      harness: "dsh",
      model: "deepseek-v4-pro",
      reasoning: null,
      access: null,
      runtimeMode: "approval-required",
    });
  });
});

describe("confirmedBySession", () => {
  it("takes the model of a session for confirmed only where the harness answered with it", () => {
    expect(confirmedBySession("codex", "gpt-6-luna").confirmed).toEqual({ model: "gpt-6-luna" });
    // The session of every other driver carries the model that was asked for.
    expect(confirmedBySession("hermes", "deepseek:deepseek-v4-pro")).toEqual({
      confirmed: {},
      confirmedBy: {},
    });
  });
});

describe("patchFromRuntimeEvent", () => {
  it("keeps what was passed apart from what the harness read back", () => {
    expect(
      patchFromRuntimeEvent(
        configured("kimi", {
          reasoning: { option: "thinking", chosen: "high", effective: "high", applied: true },
        }),
      ),
    ).toEqual({
      passed: { reasoning: "high" },
      confirmed: { reasoning: "high" },
      confirmedBy: { reasoning: "the harness, read back from its session" },
    });
  });

  it("says what was chosen and not applied, with the reason the adapter gave", () => {
    expect(
      patchFromRuntimeEvent(
        configured("kimi", {
          reasoning: {
            option: "thinking",
            chosen: "max",
            effective: "on",
            applied: false,
            why: 'this model offers on, off for "thinking", not "max"',
          },
        }),
      ),
    ).toEqual({
      passed: { reasoning: null },
      confirmed: { reasoning: "on" },
      confirmedBy: { reasoning: "the harness, read back from its session" },
      notApplied: [
        { setting: "reasoning", why: 'this model offers on, off for "thinking", not "max"' },
      ],
    });
  });

  it("takes the model from the first message of Claude, and what the adapter handed over as passed", () => {
    expect(
      patchFromRuntimeEvent(
        configured("claudeAgent", { type: "system", subtype: "init", model: "claude-fable-5-1" }),
      ),
    ).toEqual({
      confirmed: { model: "claude-fable-5-1" },
      confirmedBy: { model: "the first message of Claude itself" },
    });
    expect(
      patchFromRuntimeEvent(
        configured("claudeAgent", { model: "claude-fable-5-1[1m]", effort: "high" }),
      ),
    ).toEqual({
      passed: { model: "claude-fable-5-1", reasoning: "high" },
      passedDetail: [
        {
          at: expect.any(String),
          when: "session",
          model: "claude-fable-5-1",
          reasoning: "high",
          settings: { model: "claude-fable-5-1[1m]", effort: "high" },
        },
      ],
    });
  });

  it("keeps the permission mode the Claude adapter handed over apart from the one Claude names", () => {
    expect(
      patchFromRuntimeEvent(
        configured("claudeAgent", {
          model: "claude-sonnet-5-5",
          effort: "low",
          permissionMode: "bypassPermissions",
          cwd: "/work",
        }),
      ),
    ).toEqual({
      passed: { model: "claude-sonnet-5-5", reasoning: "low", access: "bypassPermissions" },
      passedDetail: [
        {
          at: expect.any(String),
          when: "session",
          model: "claude-sonnet-5-5",
          reasoning: "low",
          access: "bypassPermissions",
          settings: {
            model: "claude-sonnet-5-5",
            effort: "low",
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            cwd: "/work",
          },
        },
      ],
    });
    expect(
      patchFromRuntimeEvent(
        configured("claudeAgent", {
          type: "system",
          subtype: "init",
          model: "claude-sonnet-5-5",
          permissionMode: "default",
        }),
      ),
    ).toEqual({
      confirmed: { model: "claude-sonnet-5-5", access: "default" },
      confirmedBy: {
        model: "the first message of Claude itself",
        access: "the first message of Claude itself",
      },
    });
  });

  it("finds nothing in an event that reports neither", () => {
    expect(patchFromRuntimeEvent(configured("opencode", { cwd: "/work" }))).toBeNull();
  });
});

describe("withPatch", () => {
  it("keeps what is known and replaces what is reported again", () => {
    const first = withPatch(EMPTY, {
      passed: { model: "a", reasoning: "high" },
      notApplied: [{ setting: "reasoning", why: "first" }],
    });
    const second = withPatch(first, {
      confirmed: { model: "b" },
      confirmedBy: { model: "the harness" },
      notApplied: [{ setting: "reasoning", why: "second" }],
    });
    expect(second.passed).toEqual({ model: "a", reasoning: "high" });
    expect(second.confirmed).toEqual({ model: "b" });
    expect(second.notApplied).toEqual([{ setting: "reasoning", why: "second" }]);
  });
});
