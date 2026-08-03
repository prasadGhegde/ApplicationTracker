import type {
  AnalysisBatchResult,
  ExtractionResult,
  OAuthTokens,
  OpportunityConversation,
  OpportunityCreateInput,
  OpportunityDetail,
  OpportunityFilters,
  OpportunityRecord,
  OpportunityStats,
  OpportunityUpdateInput,
  StoredEmail,
  SyncState,
} from "../domain/models.js";

export interface GmailProfile {
  readonly emailAddress: string;
  readonly historyId: string;
}

export interface GmailGateway {
  getProfile(): Promise<GmailProfile>;
  listMessageIds(label: "INBOX" | "SENT", limit: number): Promise<readonly string[]>;
  listAddedMessageIds(startHistoryId: string): Promise<{ ids: readonly string[]; latestHistoryId: string }>;
  getMessage(id: string): Promise<StoredEmail>;
}

export interface OpportunityExtractionService {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  isConfigured(): boolean;
  extract(conversation: OpportunityConversation): Promise<ExtractionResult>;
}

export interface TrackerStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  deleteSetting(key: string): void;
  getOAuthTokens(): OAuthTokens | null;
  saveOAuthTokens(tokens: OAuthTokens): void;
  clearOAuthTokens(): void;

  getKnownMessageIds(ids: readonly string[]): ReadonlySet<string>;
  getThreadIdsForMessageIds(ids: readonly string[]): ReadonlySet<string>;
  upsertEmails(messages: readonly StoredEmail[]): void;
  getEmailsForThread(threadId: string): readonly StoredEmail[];
  getConversation(threadId: string): OpportunityConversation | null;
  getRecentThreadIdsByMessageLimit(messageLimit: number): readonly string[];
  setAnalysisScopeToRecentMessages(messageLimit: number): void;
  getPendingThreadIds(limit: number): readonly string[];
  countEmails(): number;

  getSuccessfulExtractionHash(threadId: string): string | null;
  beginExtractionRun(threadId: string, inputHash: string, provider: string, model: string, promptVersion: string): number;
  completeExtractionRun(runId: number, result: ExtractionResult, opportunityId: number | null): void;
  failExtractionRun(runId: number, error: string): void;
  applyExtraction(threadId: string, inputHash: string, result: ExtractionResult): number | null;

  createOpportunity(input: OpportunityCreateInput): OpportunityRecord;
  updateOpportunity(id: number, input: OpportunityUpdateInput): OpportunityRecord | null;
  deleteOpportunity(id: number): boolean;
  listOpportunities(filters?: OpportunityFilters): readonly OpportunityRecord[];
  getOpportunity(id: number): OpportunityRecord | null;
  getOpportunityDetail(id: number): OpportunityDetail | null;
  getStats(): OpportunityStats;
  getSyncState(extractionConfigured: boolean): SyncState;
}

export interface OpportunityAnalyzer {
  analyzeThreads(threadIds: readonly string[], force?: boolean): Promise<AnalysisBatchResult>;
}
