/**
 * UsageService - scans provider transcripts and returns priced usage buckets.
 *
 * The scan reads the harnesses' own session records (Claude Code, Codex, Grok
 * Build, DeepSeek, pi, Kimi Code, OpenCode, Hermes and Antigravity) rather than T3 Code's
 * orchestration projections, so usage covers turns driven outside T3 Code too.
 * This is the approach `ccusage` takes. T3 threads and delivery engine runs
 * write into those same records, so each call is counted once, from there;
 * neither is added on its own. The one exception is pi under the delivery
 * engine, which keeps each attempt's session in the attempt's folder: the
 * engine names that folder, and it is read as a source of its own.
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed, and a file that merely grew resumes
 * from its cached parse position so only the appended bytes are read.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";

import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  HermesSettings,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  type ServerSettings as ServerSettingsValue,
  type UsageProviderKind,
  type UsageSource,
  type UsagePricing,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveAntigravityProfileDirectory } from "../provider/antigravityAuthSupport.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";
import { readHermesRecords, readOpenCodeRecords } from "./usageDatabases.ts";
import { type AntigravityBilling, readAntigravityRecords } from "./antigravityUsage.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

/** An explicit refresh ignores the TTL, but not a table fetched this recently. */
const RATES_REFRESH_FLOOR_MS = 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Longest window the UI offers, plus slack. Older entries are pruned. */
const CACHE_RETENTION_DAYS = 90;

const decodeCodexSettings = Schema.decodeOption(CodexSettings);
const decodeClaudeSettings = Schema.decodeOption(ClaudeSettings);
const decodeHermesSettings = Schema.decodeOption(HermesSettings);
const decodeAntigravitySettings = Schema.decodeOption(AntigravitySettings);
const EngineUsageSources = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({ harness: Schema.String, dir: Schema.String, parentName: Schema.String }),
  ),
});
const decodeEngineUsageSources = Schema.decodeUnknownOption(EngineUsageSources);

/** Where a harness keeps its usage, and how it is read. */
interface TranscriptSource {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly volumeId: string;
  readonly fileName?: string;
  readonly extension?: string;
  readonly parentName?: string;
  /** A SQLite store in `dir`, read whole rather than file by file. */
  readonly database?: string;
  /** Antigravity's: a database per conversation, and whose account its tokens cost. */
  readonly antigravityBilling?: AntigravityBilling;
  /** Said of the source when it cannot be read. */
  readonly missingMessage?: string;
}

/** On-disk shape of the rate snapshot. */
const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

/** The scan cache is narrowed by hand in `usageScanCache`, so JSON is enough here. */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeScanCacheFile = Schema.encodeEffect(ScanCacheJson);
const encodeUsageRecordKey = Schema.encodeSync(ScanCacheJson);
const CachedSource = Schema.Struct({ dir: Schema.String, volumeId: Schema.String });
const decodeCachedSources = Schema.decodeUnknownOption(
  Schema.Struct({ sources: Schema.Record(Schema.String, CachedSource) }),
);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    /** Refetches the rate table ahead of its TTL. See `ensureRates`. */
    readonly refreshRates: Effect.Effect<UsagePricing>;
  }
>()("t3/usage/UsageService") {}

const EMPTY_PRICING: UsagePricing = {
  status: "unavailable",
  source: LITELLM_RATES_URL,
  fetchedAt: null,
  knownModels: 0,
};

/** Empty summary, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: EMPTY_PRICING,
        scanDurationMs: 0,
      }),
    refreshRates: Effect.succeed(EMPTY_PRICING),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcessEnvironment;

  const fileCache: ScanCache = new Map();
  const sourceCache = new Map<string, typeof CachedSource.Type>();
  let cacheDirty = false;
  const isWithinDirectory = (filePath: string, dir: string) => {
    const relative = path.relative(dir, filePath);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsagePricing["status"] = "unavailable";
  // One fetch at a time. A burst of refreshes from several clients waits on
  // the first fetch and then sees a table young enough to skip its own.
  const ratesLock = yield* Semaphore.make(1);

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: rates.size,
  });

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing. `force` refetches inside the TTL so a model that
   * LiteLLM added since the last fetch gets priced now.
   */
  const loadRates = Effect.fn("UsageService.loadRates")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap((raw) => decodeRatesCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < maxAgeMs) return;
        }
      }
    }

    const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) {
      // The refresh failed; whatever we are serving is now past its TTL and
      // must not keep claiming to be fresh.
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    const parsed = parseRateTable(fetched);
    if (parsed.size === 0) return;

    rates = parsed;
    ratesFetchedAtMs = now;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(ratesCachePath, serialized)),
      Effect.catchCause(() => Effect.void),
    );
  });

  const ensureRates = (force: boolean) => ratesLock.withPermit(loadRates(force));

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

  // A settings failure must not silently discard custom rates or transcript homes.
  const readSettings = settingsService.getSettings.pipe(
    Effect.catchCause(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: Cause.squash(cause),
        }),
    ),
  );

  /**
   * A source's directory and volume as the scan reports them. Kept stable after
   * root cleanup, including aliases and clients merging pre-cleanup environment
   * summaries.
   */
  const stableSource = Effect.fn("UsageService.stableSource")(function* (
    provider: UsageProviderKind,
    directory: string,
    retentionCutoffMs: number,
  ) {
    const sourceKey = provider + "\0" + directory;
    const previous = sourceCache.get(sourceKey);
    const dir = yield* fileSystem
      .realPath(directory)
      .pipe(Effect.orElseSucceed(() => previous?.dir ?? directory));
    const currentVolumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
    const hasRetainedHistory = fileCache
      .entries()
      .some(
        ([filePath, entry]) =>
          entry.provider === provider &&
          entry.mtimeMs >= retentionCutoffMs &&
          entry.records.length + entry.tailRecords.length > 0 &&
          isWithinDirectory(filePath, dir),
      );
    // A recreated directory still reports the retained history under its old identity.
    const volumeId =
      previous?.dir === dir && (hasRetainedHistory || !currentVolumeId)
        ? previous.volumeId || currentVolumeId
        : currentVolumeId;
    if (previous?.dir !== dir || previous.volumeId !== volumeId) {
      sourceCache.set(sourceKey, { dir, volumeId });
      cacheDirty = true;
    }
    return { dir, volumeId };
  });

  /**
   * Antigravity's stores of conversations: its CLI's (`agy`, which the delivery
   * engine runs too), and the profile T3 gives each of its Antigravity instances.
   * A Google account spends the plan; a key or Agent Platform bills the tokens.
   */
  const antigravitySources = (settings: ServerSettingsValue) => {
    const geminiHome =
      hostEnvironment.GEMINI_HOME?.trim() || path.join(NodeOS.homedir(), ".gemini");
    const sources: { directory: string; billing: AntigravityBilling }[] = [
      {
        directory: path.join(expandHomePath(geminiHome), "antigravity-cli", "conversations"),
        billing: "antigravity",
      },
    ];
    const instances = Object.entries(settings.providerInstances)
      .filter(([, instance]) => instance.driver === "antigravity")
      .map(([id, instance]) => ({ id, config: instance.config }));
    if (!Object.hasOwn(settings.providerInstances, "antigravity")) {
      instances.push({ id: "antigravity", config: settings.providers.antigravity });
    }
    for (const { id, config: instanceConfig } of instances) {
      const decoded = decodeAntigravitySettings(instanceConfig ?? {});
      const authMethod = Option.isSome(decoded) ? decoded.value.authMethod : "oauth-personal";
      sources.push({
        directory: path.join(
          resolveAntigravityProfileDirectory(config.stateDir, ProviderInstanceId.make(id)),
          "antigravity-acp",
          "conversations",
        ),
        billing:
          authMethod === "gemini-api-key"
            ? "gemini"
            : authMethod === "agent-platform"
              ? "vertex_ai"
              : "antigravity",
      });
    }
    return sources;
  };

  /** Resolves the transcript directory for each provider. */
  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* (
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
  ) {
    const dirs: TranscriptSource[] = [];
    const seen = new Set<string>();
    for (const driver of [
      "claudeAgent",
      "codex",
      "grok",
      "deepseek",
      "pi",
      "kimi",
      "opencode",
      "hermes",
    ] as const) {
      // Disabled accounts still have history. Explicit default slots replace
      // the legacy settings, just as they do in the provider registry.
      const instances: Array<Pick<ProviderInstanceConfig, "config" | "environment">> =
        Object.values(settings.providerInstances).filter((instance) => instance.driver === driver);
      if (!Object.hasOwn(settings.providerInstances, driver)) {
        instances.push({ config: settings.providers[driver] });
      }
      for (const instance of instances) {
        const environment = mergeProviderInstanceEnvironment(instance.environment, hostEnvironment);
        const provider = driver === "claudeAgent" ? "claude" : driver;
        let home: string;
        if (driver === "codex") {
          const decoded = decodeCodexSettings(instance.config ?? {});
          if (Option.isNone(decoded)) continue;
          const config = decoded.value;
          const environmentHome = environment.CODEX_HOME?.trim();
          const layout = yield* resolveCodexHomeLayout(
            !config.homePath.trim() && !config.shadowHomePath.trim() && environmentHome
              ? { ...config, homePath: environmentHome }
              : config,
          );
          home = layout.sharedHomePath;
        } else if (driver === "claudeAgent") {
          const decoded = decodeClaudeSettings(instance.config ?? {});
          if (Option.isNone(decoded)) continue;
          const configured = decoded.value.homePath.trim();
          home = configured
            ? expandHomePath(configured)
            : environment.CLAUDE_CONFIG_DIR?.trim() || path.join(NodeOS.homedir(), ".claude");
        } else if (driver === "deepseek") {
          home = expandHomePath(
            environment.DSH_HOME?.trim() || path.join(NodeOS.homedir(), ".dsh"),
          );
        } else if (driver === "pi") {
          home = expandHomePath(
            environment.PI_CODING_AGENT_DIR?.trim() || path.join(NodeOS.homedir(), ".pi", "agent"),
          );
        } else if (driver === "kimi") {
          home = expandHomePath(
            environment.KIMI_CODE_HOME?.trim() || path.join(NodeOS.homedir(), ".kimi-code"),
          );
        } else if (driver === "opencode") {
          const dataHome =
            environment.XDG_DATA_HOME?.trim() || path.join(NodeOS.homedir(), ".local", "share");
          home = path.join(expandHomePath(dataHome), "opencode");
        } else if (driver === "hermes") {
          const decoded = decodeHermesSettings(instance.config ?? {});
          const configured = Option.isSome(decoded) ? decoded.value.homePath.trim() : "";
          home = configured
            ? expandHomePath(configured)
            : environment.HERMES_HOME?.trim() ||
              (environment.LOCALAPPDATA?.trim()
                ? path.join(environment.LOCALAPPDATA.trim(), "hermes")
                : path.join(NodeOS.homedir(), ".hermes"));
        } else {
          home = expandHomePath(
            environment.GROK_HOME?.trim() || path.join(NodeOS.homedir(), ".grok"),
          );
        }
        // The DeepSeek harness keeps the running totals of each session in its store.
        // OpenCode and Hermes keep theirs in a database in their home.
        const directory =
          provider === "deepseek"
            ? path.resolve(home, "storages", "session_projcache", "sessions")
            : provider === "opencode" || provider === "hermes"
              ? path.resolve(home)
              : path.resolve(home, provider === "claude" ? "projects" : "sessions");
        const { dir, volumeId } = yield* stableSource(provider, directory, retentionCutoffMs);
        const key = `${provider}\0${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dirs.push({
          provider,
          dir,
          volumeId,
          ...(provider === "grok" ? { fileName: "updates.jsonl" } : {}),
          ...(provider === "kimi" ? { fileName: "wire.jsonl" } : {}),
          ...(provider === "deepseek" ? { extension: ".json" } : {}),
          ...(provider === "opencode" ? { database: path.join(dir, "opencode.db") } : {}),
          ...(provider === "hermes" ? { database: path.join(dir, "state.db") } : {}),
        });
      }
    }
    for (const source of antigravitySources(settings)) {
      const { dir, volumeId } = yield* stableSource(
        "antigravity",
        source.directory,
        retentionCutoffMs,
      );
      const key = `antigravity\0${dir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push({
        provider: "antigravity",
        dir,
        volumeId,
        extension: ".db",
        antigravityBilling: source.billing,
      });
    }
    for (const source of yield* engineSources(settings)) {
      const key = `${source.provider}\0${source.dir}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push({
        ...source,
        volumeId: yield* Effect.promise(() => readDirectoryVolumeId(source.dir)),
      });
    }
    return dirs;
  });

  /**
   * Stores of usage the delivery engine keeps outside the harnesses' own: pi's
   * sessions of the engine's attempts, in the engine's folder of runs. The
   * engine names them; it is asked only on this host, and only when delivery
   * is on. An engine that does not answer is reported, not guessed at.
   */
  const engineSources = Effect.fn("UsageService.engineSources")(function* (
    settings: ServerSettingsValue,
  ) {
    const engineUrl = settings.delivery.enabled ? settings.delivery.engineUrl.trim() : "";
    if (!engineUrl) return [] as TranscriptSource[];
    let url: string;
    try {
      const base = new URL(engineUrl);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) return [];
      url = new URL("/api/usage/sources", base).toString();
    } catch {
      return [];
    }
    const body = yield* httpClient.get(url).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(3_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    const decoded = body === null ? Option.none() : decodeEngineUsageSources(body);
    if (Option.isNone(decoded)) {
      return [
        {
          provider: "pi",
          dir: engineUrl,
          volumeId: "",
          missingMessage:
            "The delivery engine did not name its pi sessions, so pi runs of the engine are not counted.",
        },
      ] satisfies TranscriptSource[];
    }
    return decoded.value.sources
      .filter((source) => source.harness === "pi" && source.dir.trim().length > 0)
      .map((source): TranscriptSource => ({
        provider: "pi",
        dir: path.resolve(source.dir),
        volumeId: "",
        parentName: source.parentName,
      }));
  });

  /**
   * Loads the persisted scan cache exactly once per process.
   *
   * `Effect.cached` makes concurrent first readers await the same load rather
   * than each seeing a "loaded" flag set before the read finished and cold
   * scanning against an empty cache.
   */
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const document = yield* fileSystem.readFileString(scanCachePath).pipe(
        Effect.flatMap((raw) => decodeScanCacheFile(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (document === null) return;
      for (const [path, entry] of decodeScanCache(document)) fileCache.set(path, entry);
      const sources = decodeCachedSources(document);
      if (Option.isSome(sources)) {
        for (const [key, source] of Object.entries(sources.value.sources))
          sourceCache.set(key, source);
      }
    }),
  );

  const persistScanCache = Effect.fn("UsageService.persistScanCache")(function* () {
    if (!cacheDirty) return;
    // Cleared only after the write lands, so a failed persist is retried on
    // the next scan instead of leaving disk permanently stale.
    yield* encodeScanCacheFile({
      ...encodeScanCache(fileCache),
      sources: Object.fromEntries(sourceCache),
    }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(scanCachePath, serialized)),
      Effect.map(() => {
        cacheDirty = false;
      }),
      // A cache we cannot write is a slower next start, not a failed read.
      Effect.catchCause(() => Effect.void),
    );
  });

  /**
   * Parses one transcript, reusing the cached result when it is unchanged.
   *
   * A file that only grew re-parses from the cached position, so an actively
   * written multi-hundred-megabyte rollout costs its appended bytes per scan
   * rather than a full re-read. The reader verifies the position's guard bytes
   * and silently restarts from byte 0 when they no longer match.
   */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
  ): Effect.Effect<readonly UsageRecord[]> =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return cached.tailRecords.length === 0
          ? cached.records
          : [...cached.records, ...cached.tailRecords];
      }

      // Only a strictly grown file may resume. Same size with a new mtime, or
      // a shrunken file, means rewritten content; re-parse it whole.
      const resumeFrom =
        cached !== undefined && cached.provider === provider && size > cached.size
          ? cached.position
          : undefined;

      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(filePath, provider, resumeFrom),
      );
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null)
        return cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : [];

      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass. One
      // seen set spans the cached base, the new lines, and the tail so a
      // resumed parse dedupes exactly like a full one.
      const base = parsed.resumed && cached !== undefined ? cached.records : [];
      const seen = new Set<string>();
      const records = dedupeWithinFile([...base, ...parsed.records], seen);
      const tailRecords = dedupeWithinFile(parsed.tailRecords, seen);

      fileCache.set(filePath, {
        size,
        mtimeMs,
        provider,
        records,
        tailRecords,
        position: parsed.position,
      });
      cacheDirty = true;
      return tailRecords.length === 0 ? records : [...records, ...tailRecords];
    });

  /**
   * One Antigravity conversation, reusing the cached records while it is
   * unchanged. A live conversation writes its write-ahead log first, so the
   * log's size and time count in the conversation's.
   */
  const readAntigravityFile = Effect.fn("UsageService.readAntigravityFile")(function* (
    filePath: string,
    size: number,
    mtimeMs: number,
    billing: AntigravityBilling,
  ) {
    const log = Option.getOrNull(yield* fileSystem.stat(`${filePath}-wal`).pipe(Effect.option));
    const identity = {
      size: size + Number(log?.size ?? 0),
      mtimeMs: Math.max(
        mtimeMs,
        log ? Option.match(log.mtime, { onNone: () => 0, onSome: (time) => time.getTime() }) : 0,
      ),
    };
    const cached = fileCache.get(filePath);
    const own = cached?.provider === "antigravity" ? cached : undefined;
    if (own && own.size === identity.size && own.mtimeMs === identity.mtimeMs) return own.records;
    const conversationId = path.basename(filePath, ".db");
    const records = yield* Effect.sync(() =>
      readAntigravityRecords(filePath, conversationId, billing),
    );
    // A database that cannot be read now is not one without usage.
    if (records === null) return own?.records ?? [];
    const deduped = dedupeWithinFile(records, new Set());
    fileCache.set(filePath, {
      ...identity,
      provider: "antigravity",
      records: deduped,
      tailRecords: [],
      position: { resumeOffset: identity.size, guardLength: 0, guardHash: 0, codexState: null },
    });
    cacheDirty = true;
    return deduped;
  });

  /** One provider directory's walk and parse, before rates are involved. */
  interface ScannedDir {
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly volumeId: string;
    /** Why the source gave nothing, when it could not be read. */
    readonly failure?: string;
    /** Parsed records per file, or `null` when the directory does not exist. */
    readonly files:
      | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
      | null;
  }

  const collectDirs = Effect.fn("UsageService.collectDirs")(function* (
    windowStartMs: number,
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
  ) {
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so the scan stays context-free.
    const dirs = yield* resolveTranscriptDirs(settings, retentionCutoffMs).pipe(
      Effect.provideService(Path.Path, path),
    );
    const scanned: ScannedDir[] = [];
    for (const {
      provider,
      dir,
      volumeId,
      fileName,
      extension,
      parentName,
      database,
      antigravityBilling,
      missingMessage,
    } of dirs) {
      if (missingMessage !== undefined) {
        scanned.push({ provider, dir, volumeId, files: null, failure: missingMessage });
        continue;
      }
      const exists = yield* fileSystem
        .exists(database ?? dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      if (!exists) {
        scanned.push({ provider, dir, volumeId, files: null });
        continue;
      }
      if (database !== undefined) {
        const read = provider === "hermes" ? readHermesRecords : readOpenCodeRecords;
        const records = yield* Effect.sync(() => read(database, windowStartMs));
        scanned.push(
          records === null
            ? {
                provider,
                dir,
                volumeId,
                files: null,
                failure: `The store ${path.basename(database)} could not be read.`,
              }
            : { provider, dir, volumeId, files: [{ path: database, records }] },
        );
        continue;
      }
      const files = yield* Effect.promise(() =>
        listTranscriptFiles(dir, windowStartMs, {
          ...(fileName === undefined ? {} : { fileName }),
          ...(extension === undefined ? {} : { extension }),
          ...(parentName === undefined ? {} : { parentName }),
        }),
      );
      const parsedFiles: { path: string; records: readonly UsageRecord[] }[] = [];
      for (const file of files) {
        const records =
          antigravityBilling === undefined
            ? yield* readFileRecords(file.path, file.size, file.mtimeMs, provider)
            : yield* readAntigravityFile(file.path, file.size, file.mtimeMs, antigravityBilling);
        parsedFiles.push({ path: file.path, records });
      }
      scanned.push({ provider, dir, volumeId, files: parsedFiles });
    }
    return scanned;
  });

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
  ) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const retentionCutoffMs = startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    // Pricing only matters once records are aggregated, so the rate table
    // loads while transcripts stream instead of gating them: a cold rates
    // fetch on a slow network no longer delays the scan by its own timeout.
    const [, scannedDirs] = yield* Effect.all(
      [ensureRates(false), collectDirs(windowStartMs, settings, retentionCutoffMs)],
      { concurrency: 2 },
    );

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
    });

    const sources: UsageSource[] = [];

    for (const { provider, dir, volumeId, files, failure } of scannedDirs) {
      const retainedFiles = [...(files ?? [])];
      const livePaths = new Set(retainedFiles.map((file) => file.path));
      // Cleanup may remove transcripts, but the usage we already saved still
      // contributes to this source. Keep the normal aggregation and dedupe path.
      for (const [filePath, entry] of fileCache) {
        if (
          entry.provider !== provider ||
          entry.mtimeMs < retentionCutoffMs ||
          livePaths.has(filePath) ||
          !isWithinDirectory(filePath, dir)
        )
          continue;
        retainedFiles.push({ path: filePath, records: [...entry.records, ...entry.tailRecords] });
      }
      let scannedFiles = 0;
      let skippedFiles = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();

      for (const file of retainedFiles) {
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const codexEventOccurrences = new Map<string, number>();
        for (const record of file.records) {
          let usageRecord = record;
          if (record.provider === "codex" && record.sessionId.length > 0) {
            // Match moved rollout copies without collapsing repeated equal events
            // within one rollout (timestamps can have only second precision).
            const key = encodeUsageRecordKey([
              record.provider,
              record.sessionId,
              record.timestampMs,
              record.model,
              record.totals,
            ]);
            const occurrence = (codexEventOccurrences.get(key) ?? 0) + 1;
            codexEventOccurrences.set(key, occurrence);
            usageRecord = { ...record, dedupeKey: key + ":" + occurrence };
          }
          // Only sessions contributing in-window count; the mtime slack can
          // admit boundary files whose records fall outside the range.
          if (aggregator.add(usageRecord) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      sources.push({
        fingerprint: { hostId, provider, resolvedHomePath: dir, volumeId },
        // Clients exclude missing sources, so saved records remain an available source.
        status:
          failure !== undefined && scannedFiles === 0
            ? "failed"
            : files === null && scannedFiles === 0
              ? "missing"
              : "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message:
          failure ?? (files === null ? "No transcript directory on this environment." : null),
      });
    }

    const pruned = pruneScanCache(fileCache, retentionCutoffMs);
    if (pruned > 0) cacheDirty = true;
    yield* persistScanCache();

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: pricing(),
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  /**
   * In-flight scans by window and custom prices, so concurrent identical requests (the usage
   * page open on two clients at once) share one scan instead of racing over
   * the same corpus twice.
   */
  const inflightScans = new Map<string, Deferred.Deferred<UsageSummary, UsageReadError>>();

  const scanKey = (
    input: UsageSummaryInput,
    priceOverrides: ServerSettingsValue["usagePriceOverrides"],
  ): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      priceOverrides,
    ]);

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    const settings = yield* readSettings;
    const key = scanKey(input, settings.usagePriceOverrides);
    const deferred = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = inflightScans.get(key);
        if (existing !== undefined) return existing;

        // Enrollment and detached-fiber creation must be atomic. Otherwise a
        // canceled first caller can leave a Deferred with no scan to finish it.
        const created = Deferred.makeUnsafe<UsageSummary, UsageReadError>();
        inflightScans.set(key, created);
        // Detached so one departing client cannot tear the scan out from under
        // the fibers awaiting it; a finished scan warms the cache either way.
        yield* scanSummary(input, settings).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => inflightScans.delete(key)).pipe(
              Effect.andThen(Deferred.done(created, exit)),
            ),
          ),
          Effect.forkDetach,
        );
        return created;
      }),
    );
    // Waiting stays interruptible. The detached scan continues for other
    // callers and still warms the cache if this caller leaves.
    return yield* Deferred.await(deferred);
  });

  return { readSummary, refreshRates } as const;
});

export const layer = Layer.effect(UsageService, make);
