import {
  LinkedArrivalProofInput,
  LinkedArrivalProofResult,
  LinkedHandoffPeerAct,
  LinkedHandoffPeerRead,
  type LinkedHandoffPeerRequest,
  LinkedHandoffPeerResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as DeliveryService from "../../delivery/DeliveryService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../../peer/PeerLinks.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";

const DeliveryLinkedHandoffTool = Tool.make("delivery_linked_handoff", {
  description: "Relay a hand-off phase through an authenticated delivery peer link.",
  parameters: Schema.Struct({ request: LinkedHandoffPeerAct }),
  success: LinkedHandoffPeerResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    DeliveryService.DeliveryService,
  ],
})
  .annotate(Tool.Readonly, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenUnlessLinkedDeliveryPeer);

const DeliveryLinkedHandoffReadTool = Tool.make("delivery_linked_handoff_read", {
  description: "Read hand-offs started by the authenticated delivery peer link.",
  parameters: Schema.Struct({ request: LinkedHandoffPeerRead }),
  success: LinkedHandoffPeerResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, DeliveryService.DeliveryService],
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenUnlessLinkedDeliveryPeer);

const DeliveryLinkedOriginTool = Tool.make("delivery_linked_origin", {
  description: "Prove a reciprocal link for delivery arrival provenance.",
  parameters: LinkedArrivalProofInput,
  success: LinkedArrivalProofResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, PeerLinks.PeerLinks],
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenUnlessLinkedDeliveryPeer);

export const LinkedDeliveryToolkit = Toolkit.make(
  DeliveryLinkedHandoffTool,
  DeliveryLinkedHandoffReadTool,
  DeliveryLinkedOriginTool,
);

const linkedHandoff = Effect.fn("mcp.deliveryLinkedHandoff")(function* ({
  request,
}: {
  readonly request: LinkedHandoffPeerRequest;
}) {
  const { environmentId } = yield* McpInvocationContext.McpInvocationContext;
  const delivery = yield* DeliveryService.DeliveryService;
  return yield* delivery.peerHandoff(request).pipe(
    Effect.map((data) => ({ environmentId, data, error: null })),
    Effect.catchTags({
      DeliveryError: (error) =>
        Effect.succeed({
          environmentId,
          data: null,
          error: {
            message: error.detail,
            refused: error.reason === "refused",
            status: error.status,
          },
        }),
    }),
  );
});

const handlers = {
  delivery_linked_handoff: McpToolAccess.writes(linkedHandoff, { linkedCallers: "allowed" }),
  delivery_linked_handoff_read: McpToolAccess.reads(linkedHandoff),
  delivery_linked_origin: McpToolAccess.reads(
    Effect.fn("mcp.deliveryLinkedOrigin")(function* (input: typeof LinkedArrivalProofInput.Type) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.client?.linked !== true || !scope.capabilities.has("orchestration")) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "A delivery peer link is required.",
        });
      }
      const links = yield* PeerLinks.PeerLinks;
      const proof = yield* links
        .arrivalProof(input.environmentId, input.challenge, input.claim)
        .pipe(Effect.orElseSucceed(() => null));
      return { environmentId: scope.environmentId, proof };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof LinkedDeliveryToolkit.tools>;

export const layer = McpToolAccess.toLayer(LinkedDeliveryToolkit, handlers);
