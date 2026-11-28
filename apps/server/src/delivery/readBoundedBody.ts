import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

class BodyTooLarge {
  readonly _tag = "BodyTooLarge";
}

export const readBoundedBody = Effect.fn("http.readBoundedBody")(function* (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
) {
  if (Number(response.headers["content-length"]) > limit)
    return yield* Effect.fail(new BodyTooLarge());
  const result = yield* Stream.runFoldEffect(
    response.stream,
    () => ({
      size: 0,
      chunks: new Array<Uint8Array>(),
    }),
    (state, chunk) => {
      const size = state.size + chunk.byteLength;
      if (size > limit) return Effect.fail(new BodyTooLarge());
      state.chunks.push(chunk);
      return Effect.succeed({ size, chunks: state.chunks });
    },
  );
  return Buffer.concat(result.chunks, result.size);
});
