import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { boardDeliveryRequest } from "../../lib/boardDelivery";
import {
  deliveryEnvironment,
  useBoardStore,
  useDeliveryAct,
  usePersonName,
} from "../../state/delivery";
import { DeliveryApprovalDialog } from "./DeliveryApprovalDialog";

export function BoardDeliveryApproval(props: {
  environmentId: EnvironmentId;
  title: string;
  description: string;
  path: string;
  body: Record<string, unknown>;
  unavailable: boolean;
  confirmation?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const allowed = useAtomValue(deliveryEnvironment.act.permissionAtom(props.environmentId));
  const act = useDeliveryAct(props.environmentId, props.title);
  const person = usePersonName();
  const setPerson = useBoardStore((state) => state.setPerson);
  return (
    <DeliveryApprovalDialog
      title={props.title}
      description={props.description}
      person={person}
      nameField
      keyLabel="Approval key"
      {...(props.confirmation ? { confirmation: props.confirmation } : {})}
      allowed={allowed}
      forbidden="This connection cannot change delivery settings."
      unavailable={props.unavailable}
      submitLabel={props.title}
      busyLabel="Saving…"
      onSubmit={({ by, key, confirmed }) =>
        act(
          props.path,
          boardDeliveryRequest(props.path, {
            ...props.body,
            by,
            key,
            ...(props.confirmation ? { confirmed } : {}),
          }),
        )
      }
      onDone={(by) => {
        setPerson(by);
        props.onDone();
      }}
      onClose={props.onClose}
    >
      <p className="text-xs text-muted-foreground">
        Supply the engine approval key directly. An approval window is not enough. T3 does not save
        the key.
      </p>
    </DeliveryApprovalDialog>
  );
}
