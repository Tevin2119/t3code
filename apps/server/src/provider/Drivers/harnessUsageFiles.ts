/**
 * Reads the usage files of the fork's harnesses (pi, Kimi Code, DeepSeek) for
 * their `scan` usage readers.
 *
 * These harnesses keep small files the shared JSONL engine cannot read as they
 * are: a Kimi log names its session only by its folder, a DeepSeek session is
 * one JSON document dated by its last write, and the delivery engine's pi
 * sessions are found only under folders it names. So each reader walks its own
 * directory, and a file is parsed again only when its size or mtime changed.
 *
 * @module provider/Drivers/harnessUsageFiles
 */
import type { ProviderUsageScan, UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

interface CachedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly records: readonly UsageRecord[];
}

/** Parsed files by path, kept for the life of the process. */
export type HarnessFileCache = Map<string, CachedFile>;

export const makeHarnessFileCache = (): HarnessFileCache => new Map();

export interface HarnessFileSource {
  readonly dir: string;
  /** Whether the file at this path, inside `dir`, holds usage. */
  readonly matches: (filePath: string) => boolean;
  readonly parse: (
    text: string,
    file: { readonly path: string; readonly mtimeMs: number },
  ) => readonly UsageRecord[];
}

/**
 * Every matching file under `source.dir` last written at or after
 * `windowStartMs`, with its records. A missing directory is `files: null`; a
 * file that cannot be read keeps its last parse and marks the source partial.
 */
export const scanHarnessFiles = Effect.fn("scanHarnessFiles")(function* (
  source: HarnessFileSource,
  windowStartMs: number,
  cache: HarnessFileCache,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { dir } = source;
  const exists = yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return { dir, files: null } satisfies ProviderUsageScan;
  const names = yield* fileSystem
    .readDirectory(dir, { recursive: true })
    .pipe(Effect.orElseSucceed(() => null));
  if (names === null) {
    return {
      dir,
      files: null,
      status: "failed",
      message: "The harness usage folder could not be read.",
    } satisfies ProviderUsageScan;
  }
  let unread = 0;
  const files: Array<{ readonly path: string; readonly records: readonly UsageRecord[] }> = [];
  for (const name of names.toSorted()) {
    const filePath = path.join(dir, name);
    if (!source.matches(filePath)) continue;
    const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
    if (Option.isNone(info)) {
      unread += 1;
      continue;
    }
    if (info.value.type !== "File") continue;
    const mtimeMs = Option.match(info.value.mtime, {
      onNone: () => 0,
      onSome: (mtime) => mtime.getTime(),
    });
    if (mtimeMs < windowStartMs) continue;
    const size = Number(info.value.size);
    const cached = cache.get(filePath);
    if (cached !== undefined && cached.size === size && cached.mtimeMs === mtimeMs) {
      files.push({ path: filePath, records: cached.records });
      continue;
    }
    const text = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
    if (Option.isNone(text)) {
      unread += 1;
      if (cached !== undefined) files.push({ path: filePath, records: cached.records });
      continue;
    }
    const records = source.parse(text.value, { path: filePath, mtimeMs });
    cache.set(filePath, { size, mtimeMs, records });
    files.push({ path: filePath, records });
  }
  return {
    dir,
    files,
    ...(unread > 0
      ? {
          status: "partial" as const,
          message: `${unread} usage file(s) could not be read; usage may be incomplete.`,
        }
      : {}),
  } satisfies ProviderUsageScan;
});

/** One record per line that parses to one. */
export function parseLines(
  text: string,
  parseLine: (line: string) => UsageRecord | null,
): readonly UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const record = parseLine(line);
    if (record !== null) records.push(record);
  }
  return records;
}

/** A cost the harness wrote. Zero is no cost: harnesses write it for plans they do not price. */
export function reportedCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
