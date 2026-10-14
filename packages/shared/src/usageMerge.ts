/**
 * Merges per-environment usage summaries into the single view the page renders.
 *
 * Pure, so the de-duplication and derivation rules can be tested without a
 * connected environment.
 *
 * @module usageMerge
 */
import {
  type UsageModelProviderSource,
  USAGE_MERGE_COMPATIBLE_SINCE,
  type EnvironmentId,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSource,
  type UsageSourceFingerprint,
  type UsageSummary,
  type UsageAccount,
  type UsageTokenTotals,
} from "@t3tools/contracts";

import { isPlanModelProvider } from "./usagePlans.ts";

export interface EnvironmentUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageSummary;
  /** The accounts this environment's user confirmed, by name. Absent: none. */
  readonly accounts?: Readonly<Record<string, UsageAccount>>;
}

/**
 * The account a bucket belongs to: the one that names its harness and its recorded
 * provider exactly. A bucket with no recorded provider belongs to none.
 */
export function accountOf(
  accounts: Readonly<Record<string, UsageAccount>> | undefined,
  bucket: Pick<UsageBucket, "provider" | "modelProvider">,
): string | null {
  if (!accounts || !bucket.modelProvider) return null;
  for (const name of [...Object.keys(accounts)].sort()) {
    const members = accounts[name]?.members ?? [];
    if (
      members.some(
        (member) =>
          member.harness === bucket.provider && member.modelProvider === bucket.modelProvider,
      )
    ) {
      return name;
    }
  }
  return null;
}

/**
 * Usage by account where the user grouped connections, and by recorded provider
 * elsewhere. Every member keeps its harness and the provider it recorded, and its
 * share is of this row's recorded tokens: not of an allowance, and not of cost.
 */
export interface AccountTotals {
  /** The account's name, or `null` for a provider no account groups. */
  readonly account: string | null;
  /** For an ungrouped row: the provider as recorded (`null` when none was). */
  readonly modelProvider: string | null;
  readonly modelProviderSource: UsageModelProviderSource | null;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly members: readonly {
    readonly harness: UsageProviderKind;
    readonly modelProvider: string | null;
    readonly totalTokens: number;
    readonly costUsd: number;
    readonly tokenShare: number;
  }[];
}

export interface ProviderTotals {
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  /**
   * The part of `costUsd` from models reached through a coding plan (see
   * `usagePlans`): API-equivalent, while the plan bills a flat fee.
   */
  readonly planCostUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

export interface ModelTotals {
  readonly model: string;
  /** The harness the model was used through. */
  readonly provider: UsageProviderKind;
  /** The company whose model it is, or `null` when the harness did not record it. */
  readonly modelProvider: string | null;
  readonly modelProviderSource: UsageModelProviderSource | null;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly tokens: UsageTokenTotals;
  readonly records: number;
  /**
   * Records whose tokens are counted here but which contributed nothing to
   * `costUsd`. When it equals `records` the cost is unknown, not zero.
   */
  readonly unpricedRecords: number;
  /**
   * Tokens with no known rates, which a custom price would cover. A cell that
   * mixes these with reported costs counts its tokens by record share.
   */
  readonly unpricedTokens: number;
  readonly costShare: number;
  /** Reached through a coding plan: its cost is API-equivalent, not billed per token. */
  readonly onPlan: boolean;
  readonly tokenShare: number;
}

/**
 * A model whose every record lacked rates has an unknown cost, not a zero one.
 * Clients must not present its `costUsd` as a real dollar figure.
 */
export function isModelCostUnknown(model: ModelTotals): boolean {
  return model.records > 0 && model.unpricedRecords >= model.records;
}

/** Usage by the company whose models answered, across harnesses. */
export interface ModelProviderTotals {
  /** `null` gathers the usage whose provider no harness recorded. */
  readonly modelProvider: string | null;
  /** `harness` when every figure's provider is known only from its harness. */
  readonly modelProviderSource: UsageModelProviderSource | null;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly harnesses: readonly UsageProviderKind[];
  /** Each harness's part of this provider's usage, largest first. Shares are of tokens. */
  readonly byHarness: readonly {
    readonly harness: UsageProviderKind;
    readonly totalTokens: number;
    readonly costUsd: number;
    readonly tokenShare: number;
  }[];
}

/**
 * Narrows the usage merged. Empty or absent sets do not narrow. A provider of
 * `""` stands for usage whose provider was not recorded.
 */
export interface UsageFilter {
  readonly harnesses?: ReadonlySet<UsageProviderKind>;
  readonly modelProviders?: ReadonlySet<string>;
  readonly models?: ReadonlySet<string>;
  /** Account names the user grouped connections under. */
  readonly accounts?: ReadonlySet<string>;
}

export interface DailyTotals {
  readonly day: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface HourlyTotals {
  readonly day: string;
  readonly hourStart: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface CostQuality {
  readonly providerReportedShare: number;
  readonly modelPricedShare: number;
  readonly unpricedShare: number;
  readonly cacheSavingsUsd: number;
}

/**
 * `costUsd` by token category. `unsplit` is cost no rates could split,
 * including all cost from servers that predate the split.
 */
export interface CategoryCost {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly unsplit: number;
}

/** `costUsd` by request speed. Servers that predate speeds count as standard. */
export interface SpeedCost {
  readonly standard: number;
  readonly fast: number;
  readonly ultrafast: number;
  /** What fast and ultrafast requests cost above the standard rate. */
  readonly premium: number;
}

export interface UsageContractMismatch {
  readonly environmentId: EnvironmentId;
  readonly direction: "serverBehind" | "clientBehind";
  readonly contractVersion: number;
}

export interface MergedUsage {
  readonly costUsd: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly providers: readonly ProviderTotals[];
  readonly models: readonly ModelTotals[];
  readonly modelProviders: readonly ModelProviderTotals[];
  /** Usage by the accounts the user grouped, and by recorded provider for the rest. */
  readonly accounts: readonly AccountTotals[];
  /**
   * True when a provider or model filter narrowed the usage. Sessions are
   * counted per harness store, not per model, so the session counts are then
   * those of the harnesses as a whole and must not be read as the filter's.
   */
  readonly sessionsUnfiltered: boolean;
  readonly daily: readonly DailyTotals[];
  readonly hourly: readonly HourlyTotals[];
  readonly costQuality: CostQuality;
  readonly categoryCost: CategoryCost;
  readonly speedCost: SpeedCost;
  /** Environments whose data was dropped as a duplicate of another's. */
  readonly duplicateSources: readonly string[];
  readonly contributingEnvironments: readonly EnvironmentId[];
  readonly contractMismatches: readonly UsageContractMismatch[];
}

/**
 * Two sources are the same physical transcript directory only when host,
 * provider, path and filesystem identity all agree.
 *
 * `volumeId` is what stops two machines that happen to share a hostname and a
 * home path, which is every Mac in a fleet, from collapsing into one source and
 * having one of them silently dropped.
 */
function fingerprintKey(fingerprint: UsageSourceFingerprint): string {
  return [
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
  ].join(" ");
}

function bucketsForSource(summary: UsageSummary, source: UsageSource): readonly UsageBucket[] {
  const providerSources = summary.sources.filter(
    (entry) => entry.fingerprint.provider === source.fingerprint.provider,
  );
  return summary.buckets.filter(
    (bucket) =>
      bucket.provider === source.fingerprint.provider &&
      (bucket.sourcePath === source.fingerprint.resolvedHomePath ||
        (bucket.sourcePath === undefined && providerSources.length === 1)),
  );
}

function bucketKey(bucket: UsageBucket): string {
  return JSON.stringify([bucket.day, bucket.hourStart ?? null, bucket.provider, bucket.model]);
}

/**
 * Decides which environment owns each physical transcript directory.
 *
 * Several environments on one machine (worktree servers, for instance) resolve
 * the same provider home and would otherwise double count every token. The
 * Complete scans claim a fingerprint ahead of partial scans, then the most
 * recently read scan wins within each status. A newer partial scan can still
 * contribute cells absent from an older complete scan. Environment ids break
 * ties so the result is stable when summaries have the same read time.
 */
function claimSources(environments: readonly EnvironmentUsage[]): {
  readonly ownerByFingerprint: ReadonlyMap<string, EnvironmentId>;
  readonly supplementalBucketsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlySet<UsageBucket>>;
  readonly sessionsByFingerprint: ReadonlyMap<string, number>;
  readonly duplicates: readonly string[];
} {
  const ownerByFingerprint = new Map<string, EnvironmentId>();
  const ownerScanByFingerprint = new Map<
    string,
    { environment: EnvironmentUsage; source: UsageSource }
  >();
  const seenBucketKeysByFingerprint = new Map<string, Set<string>>();
  const supplementalBucketsByEnvironment = new Map<EnvironmentId, Set<UsageBucket>>();
  const sessionsByFingerprint = new Map<string, number>();
  const duplicates: string[] = [];

  const ordered = [...environments].sort(
    (a, b) =>
      (Date.parse(b.summary.readAt) || 0) - (Date.parse(a.summary.readAt) || 0) ||
      a.environmentId.localeCompare(b.environmentId),
  );

  // A complete scan takes precedence over a newer partial scan of the same
  // directory. Partial history still contributes when no complete copy exists.
  for (const status of ["ok", "partial", "failed"] as const) {
    for (const environment of ordered) {
      for (const source of environment.summary.sources) {
        if (source.status !== status) continue;
        const key = fingerprintKey(source.fingerprint);
        if (ownerByFingerprint.has(key)) {
          duplicates.push(`${environment.label}: ${source.fingerprint.resolvedHomePath}`);
          continue;
        }
        ownerByFingerprint.set(key, environment.environmentId);
        ownerScanByFingerprint.set(key, { environment, source });
        sessionsByFingerprint.set(key, source.distinctSessions);
      }
    }
  }

  // A newer partial scan may contain usage recorded after an older complete
  // scan. Keep cells absent from the complete scan. Aggregated cells do not
  // reveal enough to reconcile overlapping records without double counting.
  for (const environment of ordered) {
    for (const source of environment.summary.sources) {
      if (source.status !== "partial") continue;
      const key = fingerprintKey(source.fingerprint);
      const owner = ownerScanByFingerprint.get(key);
      if (
        owner?.source.status !== "ok" ||
        Date.parse(environment.summary.readAt) <= Date.parse(owner.environment.summary.readAt)
      ) {
        continue;
      }
      let seen = seenBucketKeysByFingerprint.get(key);
      if (seen === undefined) {
        seen = new Set(bucketsForSource(owner.environment.summary, owner.source).map(bucketKey));
        seenBucketKeysByFingerprint.set(key, seen);
      }
      const supplemental =
        supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set<UsageBucket>();
      let added = false;
      for (const bucket of bucketsForSource(environment.summary, source)) {
        const cell = bucketKey(bucket);
        if (seen.has(cell)) continue;
        seen.add(cell);
        supplemental.add(bucket);
        added = true;
      }
      if (!added) continue;
      supplementalBucketsByEnvironment.set(environment.environmentId, supplemental);
      sessionsByFingerprint.set(
        key,
        Math.max(sessionsByFingerprint.get(key) ?? 0, source.distinctSessions),
      );
    }
  }

  return {
    ownerByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
  };
}

/** Sources this environment owns after fingerprint claims, plus their buckets. */
function ownedContribution(
  environment: EnvironmentUsage,
  ownerByFingerprint: ReadonlyMap<string, EnvironmentId>,
  supplementalBuckets: ReadonlySet<UsageBucket>,
  sessionsByFingerprint: ReadonlyMap<string, number>,
): {
  readonly buckets: readonly UsageBucket[];
  readonly sessionsByProvider: ReadonlyMap<UsageProviderKind, number>;
} {
  const ownedProviders = new Set<UsageProviderKind>();
  const ownedSources = new Set<string>();
  const sessionsByProvider = new Map<UsageProviderKind, number>();
  for (const source of environment.summary.sources) {
    if (source.status === "missing") continue;
    const key = fingerprintKey(source.fingerprint);
    if (ownerByFingerprint.get(key) === environment.environmentId) {
      const provider = source.fingerprint.provider;
      ownedProviders.add(provider);
      ownedSources.add(`${provider}\u0000${source.fingerprint.resolvedHomePath}`);
      // Distinct within a directory. Summing per-bucket session counts instead
      // would count a session once per day and model it spans.
      sessionsByProvider.set(
        provider,
        (sessionsByProvider.get(provider) ?? 0) +
          (sessionsByFingerprint.get(key) ?? source.distinctSessions),
      );
    }
  }
  return {
    buckets: environment.summary.buckets.filter(
      (bucket) =>
        supplementalBuckets.has(bucket) ||
        (bucket.sourcePath === undefined
          ? ownedProviders.has(bucket.provider)
          : ownedSources.has(`${bucket.provider}\u0000${bucket.sourcePath}`)),
    ),
    sessionsByProvider,
  };
}

function bucketTokens(bucket: UsageBucket): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    bucket.totals.uncachedInputTokens +
    bucket.totals.cachedInputTokens +
    bucket.totals.cacheCreationTokens +
    bucket.totals.outputTokens
  );
}

export function isCompatibleUsageContractVersion(version: number, expected: number): boolean {
  return version >= USAGE_MERGE_COMPATIBLE_SINCE && version <= expected;
}

const EMPTY_MERGED: MergedUsage = {
  costUsd: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  records: 0,
  sessions: 0,
  providers: [],
  models: [],
  modelProviders: [],
  accounts: [],
  sessionsUnfiltered: false,
  daily: [],
  hourly: [],
  costQuality: {
    providerReportedShare: 0,
    modelPricedShare: 0,
    unpricedShare: 0,
    cacheSavingsUsd: 0,
  },
  categoryCost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unsplit: 0 },
  speedCost: { standard: 0, fast: 0, ultrafast: 0, premium: 0 },
  duplicateSources: [],
  contributingEnvironments: [],
  contractMismatches: [],
};

/**
 * Merges every connected environment's summary.
 *
 * `expectedContractVersion` guards against incompatible server code: rather
 * than blocking the page, its data is excluded and the mismatch direction is
 * reported so the UI can identify which side needs updating. Versions in
 * [{@link USAGE_MERGE_COMPATIBLE_SINCE}, expected] still merge, so an additive
 * provider expansion does not drop Claude/Codex totals from older servers.
 */
export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
  filter: UsageFilter = {},
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;
  const narrows = <T>(set: ReadonlySet<T> | undefined): set is ReadonlySet<T> =>
    set !== undefined && set.size > 0;
  const keepsHarness = (provider: UsageProviderKind) =>
    !narrows(filter.harnesses) || filter.harnesses.has(provider);
  const keepsBucket = (bucket: UsageBucket, account: string | null) =>
    keepsHarness(bucket.provider) &&
    (!narrows(filter.modelProviders) || filter.modelProviders.has(bucket.modelProvider ?? "")) &&
    (!narrows(filter.models) || filter.models.has(bucket.model)) &&
    (!narrows(filter.accounts) || (account !== null && filter.accounts.has(account)));
  const sessionsUnfiltered =
    narrows(filter.modelProviders) || narrows(filter.models) || narrows(filter.accounts);
  const accountAccumulator = new Map<
    string,
    {
      account: string | null;
      modelProvider: string | null;
      sources: Set<UsageModelProviderSource | null>;
      costUsd: number;
      totalTokens: number;
      records: number;
      unpricedRecords: number;
      members: Map<
        string,
        {
          harness: UsageProviderKind;
          modelProvider: string | null;
          totalTokens: number;
          costUsd: number;
        }
      >;
    }
  >();

  const current: EnvironmentUsage[] = [];
  const contractMismatches: UsageContractMismatch[] = [];
  for (const environment of environments) {
    if (
      isCompatibleUsageContractVersion(environment.summary.contractVersion, expectedContractVersion)
    ) {
      current.push(environment);
    } else {
      contractMismatches.push({
        environmentId: environment.environmentId,
        direction:
          environment.summary.contractVersion < expectedContractVersion
            ? "serverBehind"
            : "clientBehind",
        contractVersion: environment.summary.contractVersion,
      });
    }
  }

  const {
    ownerByFingerprint,
    supplementalBucketsByEnvironment,
    sessionsByFingerprint,
    duplicates,
  } = claimSources(current);

  let costUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let records = 0;
  let sessions = 0;
  let cacheSavingsUsd = 0;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;
  const categoryCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const speedCost = { fast: 0, ultrafast: 0, premium: 0 };

  const providerAccumulator = new Map<
    UsageProviderKind,
    { costUsd: number; planCostUsd: number; totalTokens: number; records: number; sessions: number }
  >();
  const modelProviderAccumulator = new Map<
    string,
    {
      modelProvider: string | null;
      sources: Set<UsageModelProviderSource | null>;
      costUsd: number;
      totalTokens: number;
      records: number;
      unpricedRecords: number;
      harnesses: Set<UsageProviderKind>;
      byHarness: Map<UsageProviderKind, { totalTokens: number; costUsd: number }>;
    }
  >();
  const modelAccumulator = new Map<
    string,
    {
      provider: UsageProviderKind;
      model: string;
      modelProvider: string | null;
      modelProviderSource: UsageModelProviderSource | null;
      costUsd: number;
      totalTokens: number;
      tokens: UsageTokenTotals;
      records: number;
      unpricedRecords: number;
      unpricedTokens: number;
    }
  >();
  const dailyAccumulator = new Map<
    string,
    {
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const hourlyAccumulator = new Map<
    string,
    {
      day: string;
      hourStart: string;
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const contributingEnvironments: EnvironmentId[] = [];

  for (const environment of current) {
    const owned = ownedContribution(
      environment,
      ownerByFingerprint,
      supplementalBucketsByEnvironment.get(environment.environmentId) ?? new Set(),
      sessionsByFingerprint,
    );
    const accountOfBucket = new Map(
      owned.buckets.map((bucket) => [bucket, accountOf(environment.accounts, bucket)] as const),
    );
    const buckets = owned.buckets.filter((bucket) =>
      keepsBucket(bucket, accountOfBucket.get(bucket) ?? null),
    );
    if (buckets.length > 0) contributingEnvironments.push(environment.environmentId);

    for (const [providerKind, providerSessions] of owned.sessionsByProvider) {
      if (!keepsHarness(providerKind)) continue;
      sessions += providerSessions;
      if (providerSessions === 0) continue;
      const provider = providerAccumulator.get(providerKind) ?? {
        costUsd: 0,
        planCostUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      };
      provider.sessions += providerSessions;
      providerAccumulator.set(providerKind, provider);
    }

    for (const bucket of buckets) {
      const tokens = bucketTokens(bucket);

      costUsd += bucket.costUsd;
      cacheSavingsUsd += bucket.cacheSavingsUsd;
      uncachedInputTokens += bucket.totals.uncachedInputTokens;
      cachedInputTokens += bucket.totals.cachedInputTokens;
      cacheCreationTokens += bucket.totals.cacheCreationTokens;
      outputTokens += bucket.totals.outputTokens;
      reasoningTokens += bucket.totals.reasoningTokens;
      records += bucket.records;
      unpricedRecords += bucket.unpricedRecords;
      if (bucket.costSource === "providerReported") providerReportedRecords += bucket.records;
      if (bucket.categoryCostUsd !== undefined) {
        categoryCost.input += bucket.categoryCostUsd.input;
        categoryCost.cacheRead += bucket.categoryCostUsd.cacheRead;
        categoryCost.cacheWrite += bucket.categoryCostUsd.cacheWrite;
        categoryCost.output += bucket.categoryCostUsd.output;
      }
      speedCost.fast += bucket.fastCostUsd ?? 0;
      speedCost.ultrafast += bucket.ultrafastCostUsd ?? 0;
      speedCost.premium += bucket.speedPremiumUsd ?? 0;

      const provider = providerAccumulator.get(bucket.provider) ?? {
        costUsd: 0,
        planCostUsd: 0,
        totalTokens: 0,
        records: 0,
        sessions: 0,
      };
      provider.costUsd += bucket.costUsd;
      if (isPlanModelProvider(bucket.modelProvider)) provider.planCostUsd += bucket.costUsd;
      provider.totalTokens += tokens;
      provider.records += bucket.records;
      providerAccumulator.set(bucket.provider, provider);

      const modelProvider = bucket.modelProvider ?? null;
      const providerEntry = modelProviderAccumulator.get(modelProvider ?? "") ?? {
        modelProvider,
        sources: new Set<UsageModelProviderSource | null>(),
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        unpricedRecords: 0,
        harnesses: new Set<UsageProviderKind>(),
        byHarness: new Map<UsageProviderKind, { totalTokens: number; costUsd: number }>(),
      };
      providerEntry.sources.add(bucket.modelProviderSource ?? null);
      providerEntry.costUsd += bucket.costUsd;
      providerEntry.totalTokens += tokens;
      providerEntry.records += bucket.records;
      providerEntry.unpricedRecords += bucket.unpricedRecords;
      providerEntry.harnesses.add(bucket.provider);
      const through = providerEntry.byHarness.get(bucket.provider) ?? {
        totalTokens: 0,
        costUsd: 0,
      };
      through.totalTokens += tokens;
      through.costUsd += bucket.costUsd;
      providerEntry.byHarness.set(bucket.provider, through);
      modelProviderAccumulator.set(modelProvider ?? "", providerEntry);

      const account = accountOfBucket.get(bucket) ?? null;
      const accountKey =
        account === null ? `provider\u0000${modelProvider ?? ""}` : `account\u0000${account}`;
      const accountEntry = accountAccumulator.get(accountKey) ?? {
        account,
        modelProvider: account === null ? modelProvider : null,
        sources: new Set<UsageModelProviderSource | null>(),
        costUsd: 0,
        totalTokens: 0,
        records: 0,
        unpricedRecords: 0,
        members: new Map(),
      };
      accountEntry.sources.add(bucket.modelProviderSource ?? null);
      accountEntry.costUsd += bucket.costUsd;
      accountEntry.totalTokens += tokens;
      accountEntry.records += bucket.records;
      accountEntry.unpricedRecords += bucket.unpricedRecords;
      const memberKey = `${bucket.provider}\u0000${modelProvider ?? ""}`;
      const member = accountEntry.members.get(memberKey) ?? {
        harness: bucket.provider,
        modelProvider,
        totalTokens: 0,
        costUsd: 0,
      };
      member.totalTokens += tokens;
      member.costUsd += bucket.costUsd;
      accountEntry.members.set(memberKey, member);
      accountAccumulator.set(accountKey, accountEntry);

      const modelKey = [bucket.provider, modelProvider ?? "", bucket.model].join("\u0000");
      const model = modelAccumulator.get(modelKey) ?? {
        provider: bucket.provider,
        model: bucket.model,
        modelProvider,
        modelProviderSource: bucket.modelProviderSource ?? null,
        costUsd: 0,
        totalTokens: 0,
        tokens: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        records: 0,
        unpricedRecords: 0,
        unpricedTokens: 0,
      };
      model.costUsd += bucket.costUsd;
      model.totalTokens += tokens;
      model.tokens = {
        uncachedInputTokens: model.tokens.uncachedInputTokens + bucket.totals.uncachedInputTokens,
        cachedInputTokens: model.tokens.cachedInputTokens + bucket.totals.cachedInputTokens,
        cacheCreationTokens: model.tokens.cacheCreationTokens + bucket.totals.cacheCreationTokens,
        outputTokens: model.tokens.outputTokens + bucket.totals.outputTokens,
        reasoningTokens: model.tokens.reasoningTokens + bucket.totals.reasoningTokens,
      };
      model.records += bucket.records;
      model.unpricedRecords += bucket.unpricedRecords;
      if (bucket.records > 0) {
        model.unpricedTokens += (tokens * bucket.unpricedRecords) / bucket.records;
      }
      modelAccumulator.set(modelKey, model);

      const day = dailyAccumulator.get(bucket.day) ?? {
        costUsd: 0,
        totalTokens: 0,
        byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
      };
      day.costUsd += bucket.costUsd;
      day.totalTokens += tokens;
      const dayProvider = day.byProvider.get(bucket.provider) ?? { costUsd: 0, totalTokens: 0 };
      dayProvider.costUsd += bucket.costUsd;
      dayProvider.totalTokens += tokens;
      day.byProvider.set(bucket.provider, dayProvider);
      dailyAccumulator.set(bucket.day, day);

      if (bucket.hourStart !== undefined) {
        const hour = hourlyAccumulator.get(bucket.hourStart) ?? {
          day: bucket.day,
          hourStart: bucket.hourStart,
          costUsd: 0,
          totalTokens: 0,
          byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
        };
        hour.costUsd += bucket.costUsd;
        hour.totalTokens += tokens;
        const hourProvider = hour.byProvider.get(bucket.provider) ?? {
          costUsd: 0,
          totalTokens: 0,
        };
        hourProvider.costUsd += bucket.costUsd;
        hourProvider.totalTokens += tokens;
        hour.byProvider.set(bucket.provider, hourProvider);
        hourlyAccumulator.set(bucket.hourStart, hour);
      }
    }
  }

  const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens;

  const providers: ProviderTotals[] = [...providerAccumulator.entries()]
    .map(([provider, totals]) => ({
      provider,
      costUsd: totals.costUsd,
      planCostUsd: totals.planCostUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      sessions: totals.sessions,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const models: ModelTotals[] = [...modelAccumulator.values()]
    .map((totals) => ({
      model: totals.model,
      provider: totals.provider,
      modelProvider: totals.modelProvider,
      modelProviderSource: totals.modelProviderSource,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      tokens: totals.tokens,
      records: totals.records,
      unpricedRecords: totals.unpricedRecords,
      unpricedTokens: totals.unpricedTokens,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      onPlan: isPlanModelProvider(totals.modelProvider),
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const accounts: AccountTotals[] = [...accountAccumulator.values()]
    .map((totals) => ({
      account: totals.account,
      modelProvider: totals.modelProvider,
      // An account row names the account; its members say how each provider was known.
      modelProviderSource:
        totals.account !== null
          ? null
          : totals.sources.has("recorded")
            ? ("recorded" as const)
            : totals.sources.has("harness")
              ? ("harness" as const)
              : null,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      unpricedRecords: totals.unpricedRecords,
      members: [...totals.members.values()]
        .map((member) => ({
          ...member,
          tokenShare: totals.totalTokens === 0 ? 0 : member.totalTokens / totals.totalTokens,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const modelProviders: ModelProviderTotals[] = [...modelProviderAccumulator.values()]
    .map((totals) => ({
      modelProvider: totals.modelProvider,
      // Recorded by one harness and known by another's alone is still recorded.
      modelProviderSource: totals.sources.has("recorded")
        ? ("recorded" as const)
        : totals.sources.has("harness")
          ? ("harness" as const)
          : null,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      unpricedRecords: totals.unpricedRecords,
      harnesses: [...totals.harnesses].sort(),
      byHarness: [...totals.byHarness]
        .map(([harness, through]) => ({
          harness,
          totalTokens: through.totalTokens,
          costUsd: through.costUsd,
          tokenShare: totals.totalTokens === 0 ? 0 : through.totalTokens / totals.totalTokens,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const daily: DailyTotals[] = [...dailyAccumulator.entries()]
    .map(([day, totals]) => ({
      day,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      byProvider: totals.byProvider,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const hourly: HourlyTotals[] = [...hourlyAccumulator.values()].sort((a, b) =>
    a.hourStart.localeCompare(b.hourStart),
  );

  return {
    costUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    records,
    sessions,
    providers,
    models,
    modelProviders,
    accounts,
    sessionsUnfiltered,
    daily,
    hourly,
    costQuality: {
      providerReportedShare: records === 0 ? 0 : providerReportedRecords / records,
      unpricedShare: records === 0 ? 0 : unpricedRecords / records,
      modelPricedShare:
        records === 0 ? 0 : (records - providerReportedRecords - unpricedRecords) / records,
      cacheSavingsUsd,
    },
    // Clamped so float error never shows as a negative remainder.
    categoryCost: {
      ...categoryCost,
      unsplit: Math.max(
        0,
        costUsd -
          categoryCost.input -
          categoryCost.cacheRead -
          categoryCost.cacheWrite -
          categoryCost.output,
      ),
    },
    speedCost: {
      ...speedCost,
      standard: Math.max(0, costUsd - speedCost.fast - speedCost.ultrafast),
    },
    duplicateSources: duplicates,
    contributingEnvironments,
    contractMismatches,
  };
}
