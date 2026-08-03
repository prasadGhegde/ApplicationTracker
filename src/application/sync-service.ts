import type { GmailGateway, OpportunityAnalyzer, TrackerStore } from "./ports.js";
import type { SyncResult } from "../domain/models.js";

const INITIAL_INBOX_LIMIT = 250;
const INITIAL_SENT_LIMIT = 30;
const DEFAULT_INITIAL_ANALYSIS_MESSAGE_LIMIT = 200;
const FETCH_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function isHistoryExpiredError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: number | string; response?: { status?: number } };
  return Number(candidate.code ?? candidate.response?.status) === 404;
}

interface Discovery {
  readonly ids: readonly string[];
  readonly historyId: string;
  readonly emailAddress: string;
}

export class GmailSyncService {
  private running = false;

  constructor(
    private readonly createGateway: () => GmailGateway,
    private readonly store: TrackerStore,
    private readonly analyzer: OpportunityAnalyzer | null,
  ) {}

  async initialSync(analysisMessageLimit = DEFAULT_INITIAL_ANALYSIS_MESSAGE_LIMIT): Promise<SyncResult> {
    if (this.store.getSetting("initial_sync_complete") === "true") {
      throw new Error("Initial import is already complete. Use Sync new mail.");
    }
    return this.runExclusive(() => this.performInitialSync(analysisMessageLimit));
  }

  async syncNew(): Promise<SyncResult> {
    if (this.store.getSetting("initial_sync_complete") !== "true") {
      throw new Error("Run the initial 250 inbox + 30 sent import first.");
    }
    return this.runExclusive(() => this.performIncrementalSync());
  }

  private async runExclusive(operation: () => Promise<SyncResult>): Promise<SyncResult> {
    if (this.running) throw new Error("A Gmail sync is already running.");
    this.running = true;
    try {
      return await operation();
    } finally {
      this.running = false;
    }
  }

  private async performInitialSync(analysisMessageLimit: number): Promise<SyncResult> {
    const gateway = this.createGateway();
    const discovery = await this.discoverBoundedMailbox(gateway);
    return this.persistDiscovery(discovery, "initial", gateway, analysisMessageLimit);
  }

  private async performIncrementalSync(): Promise<SyncResult> {
    const gateway = this.createGateway();
    const lastHistoryId = this.store.getSetting("last_history_id");
    if (!lastHistoryId) {
      return this.persistDiscovery(await this.discoverBoundedMailbox(gateway), "history_recovery", gateway);
    }
    try {
      const profile = await gateway.getProfile();
      const added = await gateway.listAddedMessageIds(lastHistoryId);
      return this.persistDiscovery(
        { ids: added.ids, historyId: added.latestHistoryId, emailAddress: profile.emailAddress },
        "incremental",
        gateway,
      );
    } catch (error) {
      if (!isHistoryExpiredError(error)) throw error;
      return this.persistDiscovery(await this.discoverBoundedMailbox(gateway), "history_recovery", gateway);
    }
  }

  private async persistDiscovery(
    discovery: Discovery,
    mode: SyncResult["mode"],
    gateway: GmailGateway,
    initialAnalysisMessageLimit = DEFAULT_INITIAL_ANALYSIS_MESSAGE_LIMIT,
  ): Promise<SyncResult> {
    const uniqueIds = [...new Set(discovery.ids)];
    const known = this.store.getKnownMessageIds(uniqueIds);
    const newIds = uniqueIds.filter((id) => !known.has(id));
    const fetched = await mapWithConcurrency(newIds, FETCH_CONCURRENCY, (id) => gateway.getMessage(id));
    const relevantMessages = fetched.filter((message) =>
      message.labelIds.includes("INBOX") || message.labelIds.includes("SENT"),
    );
    this.store.upsertEmails(relevantMessages);

    if (mode === "initial") {
      this.store.setAnalysisScopeToRecentMessages(initialAnalysisMessageLimit);
    }

    // Includes known IDs so interrupted runs can safely finish extraction on retry.
    const discoveredThreadIds = this.store.getThreadIdsForMessageIds(uniqueIds);
    const affectedThreadIds = mode === "initial"
      ? this.store.getRecentThreadIdsByMessageLimit(initialAnalysisMessageLimit)
      : [...discoveredThreadIds];
    const analysis = this.analyzer && affectedThreadIds.length > 0
      ? await this.analyzer.analyzeThreads(affectedThreadIds)
      : null;

    const syncedAt = new Date().toISOString();
    this.store.setSetting("gmail_email_address", discovery.emailAddress);
    this.store.setSetting("last_history_id", discovery.historyId);
    this.store.setSetting("last_sync_at", syncedAt);
    this.store.setSetting("initial_sync_complete", "true");

    return {
      mode,
      discoveredMessageIds: uniqueIds.length,
      newMessagesStored: relevantMessages.length,
      ignoredMessages: fetched.length - relevantMessages.length,
      affectedThreads: affectedThreadIds.length,
      opportunitiesUpdated: analysis?.opportunitiesUpdated ?? 0,
      extractionFailures: analysis?.failures ?? 0,
      extractionSkipped: analysis
        ? analysis.notOpportunities + analysis.skippedUnchanged
        : affectedThreadIds.length,
      syncedAt,
    };
  }

  private async discoverBoundedMailbox(gateway: GmailGateway): Promise<Discovery> {
    // Capture history before listing so mail arriving during the sync is included next time.
    const profile = await gateway.getProfile();
    const [inboxIds, sentIds] = await Promise.all([
      gateway.listMessageIds("INBOX", INITIAL_INBOX_LIMIT),
      gateway.listMessageIds("SENT", INITIAL_SENT_LIMIT),
    ]);
    return {
      ids: [...inboxIds, ...sentIds],
      historyId: profile.historyId,
      emailAddress: profile.emailAddress,
    };
  }
}

export { DEFAULT_INITIAL_ANALYSIS_MESSAGE_LIMIT, INITIAL_INBOX_LIMIT, INITIAL_SENT_LIMIT };
