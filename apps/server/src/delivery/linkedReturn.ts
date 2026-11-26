import { EnvironmentId } from "@t3tools/contracts";

const returnId = /^back-([A-Za-z0-9][\w-]{0,42})-([a-f0-9]{32})$/;

export const linkedReturnPeer = (handoff: string): EnvironmentId | null => {
  const peer = returnId.exec(handoff)?.[1];
  return peer ? EnvironmentId.make(peer) : null;
};
