import * as Effect from "effect/Effect";

import * as PayloadSigner from "./PayloadSigner.ts";

export const derivePeerArrivalKey = Effect.fn("derivePeerArrivalKey")(function* (token: string) {
  const signer = yield* PayloadSigner.fromSecret(new TextEncoder().encode(token));
  return yield* signer.sign("t3:peer-arrival-key:v1");
});
