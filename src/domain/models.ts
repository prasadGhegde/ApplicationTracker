export const OPPORTUNITY_CATEGORIES = [
  "normal_application",
  "cold_email",
  "unsolicited",
  "phd",
] as const;

export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];

export const OPPORTUNITY_STATUSES = [
  "draft",
  "submitted",
  "awaiting_response",
  "replied",
  "screening",
  "assessment",
  "interview",
  "offer",
  "accepted",
  "rejected",
  "withdrawn",
  "closed",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
export type OpportunitySource = "gmail" | "manual";
export type MessageDirection = "inbound" | "outbound";

export const EDITABLE_FIELDS = [
  "category",
  "status",
  "company",
  "jobTitle",
  "recruiterName",
  "recruiterEmail",
  "location",
  "applicationDate",
  "summary",
  "notes",
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

export interface StoredEmail {
  readonly gmailMessageId: string;
  readonly threadId: string;
  readonly historyId: string | null;
  readonly internalDateMs: number;
  readonly direction: MessageDirection;
  readonly labelIds: readonly string[];
  readonly subject: string;
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly replyTo: string | null;
  readonly messageIdHeader: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly listUnsubscribe: string | null;
  readonly snippet: string;
  readonly bodyText: string;
  readonly fetchedAt: string;
}

export interface ConversationMessage {
  readonly id: string;
  readonly direction: MessageDirection;
  readonly sentAt: string;
  readonly subject: string;
  readonly fromName: string | null;
  readonly fromEmail: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly replyTo: string | null;
  readonly bodyText: string;
  readonly snippet: string;
}

export interface OpportunityConversation {
  readonly threadId: string;
  readonly accountEmail: string | null;
  readonly messages: readonly ConversationMessage[];
}

export interface ExtractedOpportunity {
  readonly isOpportunity: boolean;
  readonly category: OpportunityCategory | null;
  readonly status: OpportunityStatus | null;
  readonly company: string | null;
  readonly jobTitle: string | null;
  readonly recruiterName: string | null;
  readonly recruiterEmail: string | null;
  readonly location: string | null;
  readonly externalJobId: string | null;
  readonly applicationDate: string | null;
  readonly lastStatusDate: string | null;
  readonly hasHumanResponse: boolean;
  readonly summary: string;
  readonly confidence: number;
  readonly evidence: readonly string[];
}

export interface ExtractionResult {
  readonly extraction: ExtractedOpportunity;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly rawResult: Readonly<Record<string, unknown>>;
}

export interface OpportunityRecord {
  readonly id: number;
  readonly source: OpportunitySource;
  readonly category: OpportunityCategory;
  readonly status: OpportunityStatus;
  readonly company: string | null;
  readonly jobTitle: string | null;
  readonly recruiterName: string | null;
  readonly recruiterEmail: string | null;
  readonly location: string | null;
  readonly externalJobId: string | null;
  readonly applicationDate: string | null;
  readonly firstContactAt: string | null;
  readonly lastActivityAt: string;
  readonly hasHumanResponse: boolean;
  readonly summary: string;
  readonly notes: string;
  readonly confidence: number | null;
  readonly extractionProvider: string | null;
  readonly extractionModel: string | null;
  readonly extractedAt: string | null;
  readonly manualOverrideFields: readonly EditableField[];
  readonly threadCount: number;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OpportunityCreateInput {
  readonly category: OpportunityCategory;
  readonly status: OpportunityStatus;
  readonly company?: string | null;
  readonly jobTitle?: string | null;
  readonly recruiterName?: string | null;
  readonly recruiterEmail?: string | null;
  readonly location?: string | null;
  readonly applicationDate?: string | null;
  readonly summary?: string;
  readonly notes?: string;
}

export type OpportunityUpdateInput = Partial<OpportunityCreateInput>;

export interface OpportunityFilters {
  readonly category?: OpportunityCategory;
  readonly status?: OpportunityStatus;
  readonly query?: string;
}

export interface OpportunityStats {
  readonly total: number;
  readonly active: number;
  readonly waiting: number;
  readonly interviews: number;
  readonly offers: number;
  readonly rejections: number;
  readonly responseRate: number;
  readonly byCategory: Readonly<Record<OpportunityCategory, number>>;
  readonly byStatus: Readonly<Record<OpportunityStatus, number>>;
}

export type TimelineEventType =
  | "email_received"
  | "email_sent"
  | "created"
  | "edited"
  | "status_changed"
  | "extracted"
  | "merged";

export interface TimelineEvent {
  readonly id: string;
  readonly type: TimelineEventType;
  readonly occurredAt: string;
  readonly title: string;
  readonly description: string;
  readonly direction: MessageDirection | null;
  readonly messageId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface OpportunityDetail {
  readonly opportunity: OpportunityRecord;
  readonly timeline: readonly TimelineEvent[];
  readonly evidence: readonly string[];
}

export interface SyncState {
  readonly connected: boolean;
  readonly emailAddress: string | null;
  readonly initialSyncComplete: boolean;
  readonly lastSyncAt: string | null;
  readonly storedMessageCount: number;
  readonly opportunityCount: number;
  readonly extractionConfigured: boolean;
  readonly pendingThreadCount: number;
}

export interface SyncResult {
  readonly mode: "initial" | "incremental" | "history_recovery";
  readonly discoveredMessageIds: number;
  readonly newMessagesStored: number;
  readonly ignoredMessages: number;
  readonly affectedThreads: number;
  readonly opportunitiesUpdated: number;
  readonly extractionFailures: number;
  readonly extractionSkipped: number;
  readonly syncedAt: string;
}

export interface OAuthTokens {
  readonly access_token?: string | null;
  readonly refresh_token?: string | null;
  readonly scope?: string;
  readonly token_type?: string | null;
  readonly expiry_date?: number | null;
}

export interface ExtractionRunRecord {
  readonly id: number;
  readonly threadId: string;
  readonly inputHash: string;
  readonly status: "running" | "success" | "failed" | "skipped";
}

export interface AnalysisBatchResult {
  readonly requestedThreads: number;
  readonly analyzedThreads: number;
  readonly opportunitiesUpdated: number;
  readonly notOpportunities: number;
  readonly skippedUnchanged: number;
  readonly failures: number;
}
