import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  ProviderDriverKind,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DeliveryThreadBinding,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  deliveryModelDisabledReason,
  deliveryBindingAtom,
  modelPickerDisabledInstanceIds,
  matchesModelPickerLock,
} from "@t3tools/client-runtime/delivery-model-lock";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { makeThreadFixture } from "../test-fixtures";
import {
  deriveLockedProvider,
  getStartedThreadModelChangeBlockReason,
} from "../components/ChatView.logic";
import { modelPickerInstanceTooltip } from "../components/chat/ModelPickerSidebar";
import {
  useChatViewComposerProviderSelection,
  useChatComposerProviderSelection,
  useDeliveryThreadModelBinding,
} from "./deliveryComposerSelection";
import { getThreadModelDisabledReason } from "./deliveryModelPicker";
import { deliveryEnvironment } from "../state/delivery";

vi.mock("../state/delivery", () => ({
  deliveryEnvironment: { modelBinding: vi.fn() },
}));

const binding: DeliveryThreadBinding = {
  threadId: ThreadId.make("bound"),
  session: "session",
  team: "development",
  role: "implementer",
  seat: "developer",
  driver: "pi",
  harness: "pi",
  workspace: "/repo",
  configuration: "development@1#digest",
  requestedModel: null,
  memoryScope: "team",
  tools: [],
  project: "project",
  boundAt: "2026-10-13T00:00:00Z",
};
const providers: ServerProvider[] = [
  ["pi_work", "pi"],
  ["pi_personal", "pi"],
  ["codex_work", "codex"],
  ["codex_personal", "codex"],
  ["claude_work", "claudeAgent"],
].map(([instanceId, driver]) => ({
  instanceId: ProviderInstanceId.make(instanceId!),
  driver: ProviderDriverKind.make(driver!),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  version: null,
  checkedAt: "2026-10-13T00:00:00Z",
  slashCommands: [],
  skills: [],
  continuation: { groupKey: `${driver}:${instanceId}:profile` },
  models: ["fast", "pro"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
}));
const entries = deriveProviderInstanceEntries(providers);
const thread = makeThreadFixture({
  id: binding.threadId,
  itemCount: 1,
  modelSelection: { instanceId: ProviderInstanceId.make("pi_work"), model: "fast" },
  runtime: {
    status: "completed",
    providerName: "pi",
    providerInstanceId: ProviderInstanceId.make("pi_work"),
    activeRunId: null,
    lastError: null,
    updatedAt: "2026-10-13T00:00:00Z",
  },
});
const reason =
  "This thread is the development implementer on pi. Start a new thread to use another harness.";

describe("delivery composer selection through both production integrations", () => {
  it.each([
    { handoff: false, deliveryEnabled: false },
    { handoff: true, deliveryEnabled: false },
    { handoff: false, deliveryEnabled: true },
    { handoff: true, deliveryEnabled: true },
  ])(
    "keeps both Pi profiles selectable with handoff=$handoff, Delivery enabled=$deliveryEnabled",
    async ({ handoff, deliveryEnabled }) => {
      const query = Atom.make(AsyncResult.success({ binding, pending: null }));
      const boundAtom = deliveryBindingAtom(query, binding.threadId);
      const unboundAtom = Atom.make<DeliveryThreadBinding | null>(null);
      vi.mocked(deliveryEnvironment.modelBinding).mockReturnValue(boundAtom);
      let output: ReturnType<typeof useChatComposerProviderSelection> | undefined;
      function SelectionPath(props: { deliveryEnabled: boolean }) {
        // The setting controls new-team UI only; the production hook reads persisted bindings.
        const confirmedBinding = useDeliveryThreadModelBinding(
          EnvironmentId.make("work"),
          thread.id,
        );
        const lock = deriveLockedProvider({
          thread,
          selectedProvider: "pi_personal",
          threadProvider: "pi_work",
          providers,
          deliveryBinding: confirmedBinding,
        });
        const view = useChatViewComposerProviderSelection({
          entries,
          activeThread: thread,
          activeRuntime: thread.runtime,
          selectedProviderByThreadId: ProviderInstanceId.make("pi_personal"),
          activeProjectDefaultModelSelection: null,
          lockedProvider: lock,
          deliveryBinding: confirmedBinding,
        });
        output = useChatComposerProviderSelection({
          entries,
          activeThread: thread,
          activeThreadModelSelection: thread.modelSelection,
          selectedProviderByThreadId: view.selectedProviderEntry?.instanceId ?? null,
          activeProjectDefaultModelSelection: null,
          lockedProvider: handoff && !confirmedBinding ? null : lock,
          deliveryBinding: confirmedBinding,
        });
        expect(view.selectedProviderEntry?.instanceId).toBe(
          confirmedBinding ? "pi_personal" : "pi_work",
        );
        const disabled = modelPickerDisabledInstanceIds(
          entries,
          handoff && !confirmedBinding ? null : lock,
          output.lockedContinuationGroupKey,
        );
        for (const entry of entries) {
          const foreign = entry.driverKind !== "pi";
          if (confirmedBinding) {
            expect(disabled?.has(entry.instanceId)).toBe(foreign);
            expect(matchesModelPickerLock(entry, lock, output.lockedContinuationGroupKey)).toBe(
              !foreign,
            );
            for (const model of entry.snapshot.models) {
              const input = {
                providers,
                hasStartedSession: true,
                supportsProviderSwitchingViaHandoff: handoff,
                deliveryBinding: confirmedBinding,
                currentModelSelection: thread.modelSelection,
                nextModelSelection: { instanceId: entry.instanceId, model: model.slug },
              };
              expect(getThreadModelDisabledReason(input)).toBe(foreign ? reason : null);
              expect(getStartedThreadModelChangeBlockReason(input)?.description ?? null).toBe(
                foreign ? reason : null,
              );
            }
            expect(
              modelPickerInstanceTooltip({
                entry,
                isContextDisabled: foreign,
                contextDisabledReason: deliveryModelDisabledReason(
                  confirmedBinding,
                  entry.driverKind,
                ),
                showNewBadge: false,
              }),
            ).toBe(foreign ? reason : entry.displayName);
          }
        }
        return props.deliveryEnabled ? <span>New team controls</span> : null;
      }
      let renderer: ReactTestRenderer;
      await act(async () => {
        renderer = create(<SelectionPath deliveryEnabled={deliveryEnabled} />);
      });
      expect(output?.selectedProviderEntry?.instanceId).toBe("pi_personal");
      expect(output?.lockedContinuationGroupKey).toBeNull();
      await act(async () => {
        renderer!.update(<SelectionPath deliveryEnabled={!deliveryEnabled} />);
      });
      expect(output?.selectedProviderEntry?.instanceId).toBe("pi_personal");
      expect(output?.lockedContinuationGroupKey).toBeNull();
      vi.mocked(deliveryEnvironment.modelBinding).mockReturnValue(unboundAtom);
      await act(async () => {
        renderer!.update(<SelectionPath deliveryEnabled={deliveryEnabled} />);
      });
      vi.mocked(deliveryEnvironment.modelBinding).mockReturnValue(boundAtom);
      await act(async () => {
        renderer!.update(<SelectionPath deliveryEnabled={deliveryEnabled} />);
      });
      expect(output?.selectedProviderEntry?.instanceId).toBe("pi_personal");
      await act(async () => {
        renderer!.unmount();
      });
    },
  );
  it("prioritizes the binding explanation for an unavailable foreign sidebar instance", () => {
    const foreign = deriveProviderInstanceEntries([
      { ...providers[2]!, installed: false, status: "error", availability: "unavailable" },
    ])[0]!;
    expect(
      modelPickerInstanceTooltip({
        entry: foreign,
        isContextDisabled: true,
        contextDisabledReason: deliveryModelDisabledReason(binding, foreign.driverKind),
        showNewBadge: false,
      }),
    ).toBe(reason);
    expect(
      modelPickerInstanceTooltip({ entry: foreign, isContextDisabled: false, showNewBadge: false }),
    ).not.toBe(reason);
  });
});
