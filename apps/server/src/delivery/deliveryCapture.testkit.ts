import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import * as Schema from "effect/Schema";

const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ResponseCapture = Schema.Struct({
  path: Schema.String,
  status: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 599 })),
  headers: Schema.Record(Schema.String, Schema.String),
  bodyFile: Schema.String,
  sha256: Hash,
  uses: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
});
const CaptureCase = Schema.Struct({
  id: Schema.String,
  provenance: Schema.Literals(["engine-handler", "compatibility-mutation", "transport-fault"]),
  derivedFromSha256: Schema.optional(Hash),
  operation: Schema.Literals(["discover", "read", "act"]),
  input: Schema.Unknown,
  expectedTag: Schema.Literals(["Success", "Failure"]),
  expected: Schema.Record(Schema.String, Schema.Unknown),
  responses: Schema.Array(ResponseCapture),
  web: Schema.optional(
    Schema.Struct({
      path: Schema.String,
      decoder: Schema.Literals(["board-delivery", "board-link", "merge-permission"]),
      decodes: Schema.Boolean,
      validRouteIds: Schema.Array(Schema.String),
      progress: Schema.Array(Schema.String),
    }),
  ),
});
const CaptureSuite = Schema.Struct({
  version: Schema.Literal(1),
  engineBase: Schema.Literal("b388ee943831cef1f0a6c7ea73278f998a16696d"),
  enginePatchSha256: Hash,
  engineManifestSha256: Hash,
  consumerBase: Schema.Literal("00c1a27086921d0efeceaa817ed5c89f5a26ebc6"),
  consumerManifestSha256: Hash,
  profile: Schema.NullOr(Schema.String),
  home: Schema.String,
  cases: Schema.Array(CaptureCase).check(Schema.isMinLength(1)),
});

export function loadDeliveryCaptures(filename: string) {
  const suite = Schema.decodeUnknownSync(CaptureSuite)(JSON.parse(readFileSync(filename, "utf8")));
  if (
    suite.enginePatchSha256 !== process.env.T3_DELIVERY_CAPTURE_ENGINE_PATCH_SHA256 ||
    suite.engineManifestSha256 !== process.env.T3_DELIVERY_CAPTURE_ENGINE_MANIFEST_SHA256
  )
    throw new Error("Capture engine identity does not match the independently approved pair.");
  if (suite.consumerManifestSha256 !== process.env.T3_DELIVERY_CAPTURE_CONSUMER_SHA256)
    throw new Error(
      "Capture consumer identity does not match the independently approved manifest.",
    );
  if (new Set(suite.cases.map((entry) => entry.id)).size !== suite.cases.length)
    throw new Error("Duplicate capture case id.");
  const folder = dirname(resolve(filename));
  return {
    ...suite,
    cases: suite.cases.map((entry) => {
      if (!entry.responses.length || !Object.keys(entry.expected).length)
        throw new Error(`Capture ${entry.id} requires responses and concrete expected evidence.`);
      if (entry.provenance !== "engine-handler" && !entry.derivedFromSha256)
        throw new Error(`Capture ${entry.id} must identify its unchanged source bytes.`);
      const responses = entry.responses.map((response) => {
        if (!response.path.startsWith("/api/") || response.path.includes("#"))
          throw new Error("Capture must name an exact API path and query.");
        const file = resolve(folder, response.bodyFile);
        const child = relative(folder, file);
        if (isAbsolute(response.bodyFile) || child.startsWith("..") || isAbsolute(child))
          throw new Error("Capture body must stay inside its evidence directory.");
        const bytes = readFileSync(file);
        if (createHash("sha256").update(bytes).digest("hex") !== response.sha256)
          throw new Error(`Capture body hash mismatch: ${entry.id} ${response.path}`);
        return { ...response, bytes: new Uint8Array(bytes) };
      });
      return { ...entry, responses };
    }),
  };
}
