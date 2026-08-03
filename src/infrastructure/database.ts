import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TrackerStore } from "../application/ports.js";
import {
  EDITABLE_FIELDS,
  OPPORTUNITY_CATEGORIES,
  OPPORTUNITY_STATUSES,
  type EditableField,
  type ExtractionResult,
  type OAuthTokens,
  type OpportunityCategory,
  type OpportunityConversation,
  type OpportunityCreateInput,
  type OpportunityDetail,
  type OpportunityFilters,
  type OpportunityRecord,
  type OpportunityStats,
  type OpportunityStatus,
  type OpportunityUpdateInput,
  type StoredEmail,
  type SyncState,
  type TimelineEvent,
  type TimelineEventType,
} from "../domain/models.js";

interface EmailRow {
  gmail_message_id: string;
  thread_id: string;
  history_id: string | null;
  internal_date_ms: number;
  direction: "inbound" | "outbound";
  labels_json: string;
  subject: string;
  from_name: string | null;
  from_email: string | null;
  to_json: string;
  cc_json: string;
  reply_to: string | null;
  message_id_header: string | null;
  in_reply_to: string | null;
  references_json: string;
  list_unsubscribe: string | null;
  snippet: string;
  body_text: string;
  fetched_at: string;
}

interface OpportunityRow {
  id: number;
  source: "gmail" | "manual";
  category: OpportunityCategory;
  status: OpportunityStatus;
  company: string | null;
  job_title: string | null;
  recruiter_name: string | null;
  recruiter_email: string | null;
  location: string | null;
  external_job_id: string | null;
  application_date: string | null;
  status_date: string | null;
  first_contact_at: string | null;
  last_activity_at: string;
  has_human_response: number;
  summary: string;
  notes: string;
  confidence: number | null;
  extraction_provider: string | null;
  extraction_model: string | null;
  extraction_prompt_version: string | null;
  extraction_evidence_json: string;
  extracted_at: string | null;
  input_hash: string | null;
  company_key: string;
  role_key: string;
  manual_override_fields_json: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  thread_count: number;
  message_count: number;
}

interface TimelineRow {
  id: number;
  event_type: TimelineEventType;
  occurred_at: string;
  title: string;
  description: string;
  gmail_message_id: string | null;
  metadata_json: string;
}

const OPPORTUNITY_SELECT = `
  SELECT
    o.*,
    COUNT(DISTINCT ot.gmail_thread_id) AS thread_count,
    COUNT(DISTINCT e.gmail_message_id) AS message_count
  FROM opportunities o
  LEFT JOIN opportunity_threads ot ON ot.opportunity_id = o.id
  LEFT JOIN emails e ON e.thread_id = ot.gmail_thread_id
`;

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined): Readonly<Record<string, unknown>> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : {};
  } catch {
    return {};
  }
}

function normalizeKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(?:gmbh|ag|inc|llc|ltd|limited|corp|corporation|company|co)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim() ?? "";
  return cleaned || null;
}

function earliest(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function latest(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function mapEmail(row: EmailRow): StoredEmail {
  return {
    gmailMessageId: row.gmail_message_id,
    threadId: row.thread_id,
    historyId: row.history_id,
    internalDateMs: row.internal_date_ms,
    direction: row.direction,
    labelIds: parseJsonArray(row.labels_json),
    subject: row.subject,
    fromName: row.from_name,
    fromEmail: row.from_email,
    to: parseJsonArray(row.to_json),
    cc: parseJsonArray(row.cc_json),
    replyTo: row.reply_to,
    messageIdHeader: row.message_id_header,
    inReplyTo: row.in_reply_to,
    references: parseJsonArray(row.references_json),
    listUnsubscribe: row.list_unsubscribe,
    snippet: row.snippet,
    bodyText: row.body_text,
    fetchedAt: row.fetched_at,
  };
}

function mapOpportunity(row: OpportunityRow): OpportunityRecord {
  const manualOverrideFields = parseJsonArray(row.manual_override_fields_json)
    .filter((field): field is EditableField => (EDITABLE_FIELDS as readonly string[]).includes(field));
  return {
    id: row.id,
    source: row.source,
    category: row.category,
    status: row.status,
    company: row.company,
    jobTitle: row.job_title,
    recruiterName: row.recruiter_name,
    recruiterEmail: row.recruiter_email,
    location: row.location,
    externalJobId: row.external_job_id,
    applicationDate: row.application_date,
    firstContactAt: row.first_contact_at,
    lastActivityAt: row.last_activity_at,
    hasHumanResponse: row.has_human_response === 1,
    summary: row.summary,
    notes: row.notes,
    confidence: row.confidence,
    extractionProvider: row.extraction_provider,
    extractionModel: row.extraction_model,
    extractedAt: row.extracted_at,
    manualOverrideFields,
    threadCount: row.thread_count,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteTrackerStore implements TrackerStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    const existed = existsSync(databasePath);
    this.database = new DatabaseSync(databasePath, { timeout: 10_000 });
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
    if (!existed) chmodSync(databasePath, 0o600);
  }

  private tableExists(name: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  private columns(table: string): Set<string> {
    const rows = this.database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS emails (
        gmail_message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        history_id TEXT,
        internal_date_ms INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        labels_json TEXT NOT NULL,
        subject TEXT NOT NULL,
        from_name TEXT,
        from_email TEXT,
        to_json TEXT NOT NULL,
        reply_to TEXT,
        snippet TEXT NOT NULL,
        body_text TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      ) STRICT;
    `);

    const emailColumns = this.columns("emails");
    const additions: ReadonlyArray<[string, string]> = [
      ["cc_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["message_id_header", "TEXT"],
      ["in_reply_to", "TEXT"],
      ["references_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["list_unsubscribe", "TEXT"],
    ];
    for (const [column, definition] of additions) {
      if (!emailColumns.has(column)) this.database.exec(`ALTER TABLE emails ADD COLUMN ${column} ${definition}`);
    }

    if (this.tableExists("opportunities") && !this.columns("opportunities").has("source")) {
      if (this.tableExists("opportunities_legacy_v1")) {
        throw new Error("Both an old opportunities table and opportunities_legacy_v1 exist; migration cannot continue safely.");
      }
      this.database.exec("ALTER TABLE opportunities RENAME TO opportunities_legacy_v1");
    }

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS opportunities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL CHECK (source IN ('gmail', 'manual')),
        category TEXT NOT NULL CHECK (category IN ('normal_application', 'cold_email', 'unsolicited', 'phd')),
        status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'awaiting_response', 'replied', 'screening', 'assessment', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn', 'closed')),
        company TEXT,
        job_title TEXT,
        recruiter_name TEXT,
        recruiter_email TEXT,
        location TEXT,
        external_job_id TEXT,
        application_date TEXT,
        status_date TEXT,
        first_contact_at TEXT,
        last_activity_at TEXT NOT NULL,
        has_human_response INTEGER NOT NULL DEFAULT 0 CHECK (has_human_response IN (0, 1)),
        summary TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        confidence REAL,
        extraction_provider TEXT,
        extraction_model TEXT,
        extraction_prompt_version TEXT,
        extraction_evidence_json TEXT NOT NULL DEFAULT '[]',
        extracted_at TEXT,
        input_hash TEXT,
        company_key TEXT NOT NULL DEFAULT '',
        role_key TEXT NOT NULL DEFAULT '',
        manual_override_fields_json TEXT NOT NULL DEFAULT '[]',
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS opportunity_threads (
        opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        gmail_thread_id TEXT NOT NULL UNIQUE,
        link_reason TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY (opportunity_id, gmail_thread_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS timeline_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'edited', 'status_changed', 'extracted', 'merged')),
        occurred_at TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        gmail_message_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;

      CREATE TABLE IF NOT EXISTS extraction_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        gmail_thread_id TEXT NOT NULL,
        opportunity_id INTEGER REFERENCES opportunities(id),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
        raw_result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_emails_v2_thread_date ON emails(thread_id, internal_date_ms);
      CREATE INDEX IF NOT EXISTS idx_emails_v2_message_header ON emails(message_id_header);
      CREATE INDEX IF NOT EXISTS idx_opportunities_v2_pipeline ON opportunities(deleted_at, category, status);
      CREATE INDEX IF NOT EXISTS idx_opportunities_v2_keys ON opportunities(company_key, role_key, deleted_at);
      CREATE INDEX IF NOT EXISTS idx_opportunities_v2_activity ON opportunities(deleted_at, last_activity_at DESC);
      CREATE INDEX IF NOT EXISTS idx_timeline_v2_opportunity_date ON timeline_events(opportunity_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_extraction_v2_thread_status ON extraction_runs(gmail_thread_id, status, completed_at DESC);
      PRAGMA user_version = 2;
    `);
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getSetting(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  deleteSetting(key: string): void {
    this.database.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
  }

  getOAuthTokens(): OAuthTokens | null {
    const value = this.getSetting("oauth_tokens");
    if (!value) return null;
    try { return JSON.parse(value) as OAuthTokens; } catch { return null; }
  }

  saveOAuthTokens(tokens: OAuthTokens): void {
    const current = this.getOAuthTokens() ?? {};
    this.setSetting("oauth_tokens", JSON.stringify({
      ...current,
      ...tokens,
      refresh_token: tokens.refresh_token ?? current.refresh_token,
    }));
  }

  clearOAuthTokens(): void { this.deleteSetting("oauth_tokens"); }

  getKnownMessageIds(ids: readonly string[]): ReadonlySet<string> {
    return this.selectSetInChunks("gmail_message_id", "emails", "gmail_message_id", ids);
  }

  getThreadIdsForMessageIds(ids: readonly string[]): ReadonlySet<string> {
    return this.selectSetInChunks("thread_id", "emails", "gmail_message_id", ids);
  }

  private selectSetInChunks(selectColumn: string, table: string, matchColumn: string, values: readonly string[]): ReadonlySet<string> {
    const selected = new Set<string>();
    for (let start = 0; start < values.length; start += 500) {
      const chunk = values.slice(start, start + 500);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.database.prepare(
        `SELECT DISTINCT ${selectColumn} value FROM ${table} WHERE ${matchColumn} IN (${placeholders})`,
      ).all(...chunk) as unknown as Array<{ value: string }>;
      rows.forEach((row) => selected.add(row.value));
    }
    return selected;
  }

  upsertEmails(messages: readonly StoredEmail[]): void {
    if (messages.length === 0) return;
    const statement = this.database.prepare(`
      INSERT INTO emails(
        gmail_message_id, thread_id, history_id, internal_date_ms, direction, labels_json,
        subject, from_name, from_email, to_json, cc_json, reply_to, message_id_header,
        in_reply_to, references_json, list_unsubscribe, snippet, body_text, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(gmail_message_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        history_id = excluded.history_id,
        internal_date_ms = excluded.internal_date_ms,
        direction = excluded.direction,
        labels_json = excluded.labels_json,
        subject = excluded.subject,
        from_name = excluded.from_name,
        from_email = excluded.from_email,
        to_json = excluded.to_json,
        cc_json = excluded.cc_json,
        reply_to = excluded.reply_to,
        message_id_header = excluded.message_id_header,
        in_reply_to = excluded.in_reply_to,
        references_json = excluded.references_json,
        list_unsubscribe = excluded.list_unsubscribe,
        snippet = excluded.snippet,
        body_text = excluded.body_text,
        fetched_at = excluded.fetched_at
    `);
    this.transaction(() => {
      for (const message of messages) {
        statement.run(
          message.gmailMessageId,
          message.threadId,
          message.historyId,
          message.internalDateMs,
          message.direction,
          JSON.stringify(message.labelIds),
          message.subject,
          message.fromName,
          message.fromEmail,
          JSON.stringify(message.to),
          JSON.stringify(message.cc),
          message.replyTo,
          message.messageIdHeader,
          message.inReplyTo,
          JSON.stringify(message.references),
          message.listUnsubscribe,
          message.snippet,
          message.bodyText,
          message.fetchedAt,
        );
      }
    });
  }

  getEmailsForThread(threadId: string): readonly StoredEmail[] {
    return (this.database.prepare("SELECT * FROM emails WHERE thread_id = ? ORDER BY internal_date_ms ASC").all(threadId) as unknown as EmailRow[])
      .map(mapEmail);
  }

  getConversation(threadId: string): OpportunityConversation | null {
    const emails = this.getEmailsForThread(threadId);
    if (emails.length === 0) return null;
    return {
      threadId,
      accountEmail: this.getSetting("gmail_email_address"),
      messages: emails.map((email) => ({
        id: email.gmailMessageId,
        direction: email.direction,
        sentAt: new Date(email.internalDateMs).toISOString(),
        subject: email.subject,
        fromName: email.fromName,
        fromEmail: email.fromEmail,
        to: email.to,
        cc: email.cc,
        replyTo: email.replyTo,
        bodyText: email.bodyText,
        snippet: email.snippet,
      })),
    };
  }

  getRecentThreadIdsByMessageLimit(messageLimit: number): readonly string[] {
    const rows = this.database.prepare(`
      SELECT thread_id, MAX(internal_date_ms) newest
      FROM (SELECT thread_id, internal_date_ms FROM emails ORDER BY internal_date_ms DESC LIMIT ?)
      GROUP BY thread_id ORDER BY newest DESC
    `).all(messageLimit) as unknown as Array<{ thread_id: string }>;
    return rows.map((row) => row.thread_id);
  }

  setAnalysisScopeToRecentMessages(messageLimit: number): void {
    const normalizedLimit = Math.max(1, Math.floor(messageLimit));
    const row = this.database.prepare(`
      SELECT internal_date_ms
      FROM emails
      ORDER BY internal_date_ms DESC
      LIMIT 1 OFFSET ?
    `).get(normalizedLimit - 1) as { internal_date_ms: number } | undefined;
    const fallback = this.database.prepare("SELECT MIN(internal_date_ms) internal_date_ms FROM emails")
      .get() as { internal_date_ms: number | null };
    const cutoff = row?.internal_date_ms ?? fallback.internal_date_ms;
    if (cutoff !== null) this.setSetting("analysis_min_internal_date_ms", String(cutoff));
  }

  getPendingThreadIds(limit: number): readonly string[] {
    const rows = this.database.prepare(`
      SELECT e.thread_id, MAX(e.internal_date_ms) newest
      FROM emails e
      WHERE e.internal_date_ms >= COALESCE(
        CAST((SELECT value FROM app_settings WHERE key = 'analysis_min_internal_date_ms') AS INTEGER),
        0
      )
      AND NOT EXISTS (
        SELECT 1 FROM extraction_runs r
        WHERE r.gmail_thread_id = e.thread_id AND r.status = 'success'
      )
      GROUP BY e.thread_id
      ORDER BY newest DESC
      LIMIT ?
    `).all(limit) as unknown as Array<{ thread_id: string }>;
    return rows.map((row) => row.thread_id);
  }

  countEmails(): number {
    return (this.database.prepare("SELECT COUNT(*) count FROM emails").get() as { count: number }).count;
  }

  getSuccessfulExtractionHash(threadId: string): string | null {
    const row = this.database.prepare(`
      SELECT input_hash FROM extraction_runs
      WHERE gmail_thread_id = ? AND status = 'success'
      ORDER BY completed_at DESC, id DESC LIMIT 1
    `).get(threadId) as { input_hash: string } | undefined;
    return row?.input_hash ?? null;
  }

  beginExtractionRun(threadId: string, inputHash: string, provider: string, model: string, promptVersion: string): number {
    const result = this.database.prepare(`
      INSERT INTO extraction_runs(gmail_thread_id, provider, model, prompt_version, input_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?)
    `).run(threadId, provider, model, promptVersion, inputHash, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  completeExtractionRun(runId: number, result: ExtractionResult, opportunityId: number | null): void {
    this.database.prepare(`
      UPDATE extraction_runs
      SET status = 'success', opportunity_id = ?, raw_result_json = ?, completed_at = ?
      WHERE id = ?
    `).run(opportunityId, JSON.stringify(result.rawResult), new Date().toISOString(), runId);
  }

  failExtractionRun(runId: number, error: string): void {
    this.database.prepare(`
      UPDATE extraction_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?
    `).run(error, new Date().toISOString(), runId);
  }

  applyExtraction(threadId: string, inputHash: string, result: ExtractionResult): number | null {
    const extracted = result.extraction;
    if (!extracted.isOpportunity || !extracted.category || !extracted.status) return null;

    return this.transaction(() => {
      const linked = this.database.prepare(`
        SELECT o.* FROM opportunities o
        INNER JOIN opportunity_threads ot ON ot.opportunity_id = o.id
        WHERE ot.gmail_thread_id = ?
      `).get(threadId) as OpportunityRow | undefined;
      if (linked?.deleted_at) return null;

      const companyKey = normalizeKey(extracted.company);
      const roleKey = normalizeKey(extracted.jobTitle);
      let opportunityId = linked?.id ?? null;
      let linkReason = "gmail_thread";

      if (!opportunityId && extracted.externalJobId) {
        const match = this.database.prepare(`
          SELECT id FROM opportunities
          WHERE deleted_at IS NULL AND external_job_id = ?
            AND (? = '' OR company_key = ?)
          ORDER BY last_activity_at DESC LIMIT 1
        `).get(extracted.externalJobId, companyKey, companyKey) as { id: number } | undefined;
        if (match) {
          opportunityId = match.id;
          linkReason = "dedupe_job_id";
        }
      }
      if (!opportunityId && companyKey && roleKey) {
        const match = this.database.prepare(`
          SELECT id FROM opportunities
          WHERE deleted_at IS NULL AND company_key = ? AND role_key = ?
            AND last_activity_at >= datetime('now', '-365 days')
          ORDER BY last_activity_at DESC LIMIT 1
        `).get(companyKey, roleKey) as { id: number } | undefined;
        if (match) {
          opportunityId = match.id;
          linkReason = "dedupe_company_role";
        }
      }
      if (!opportunityId && extracted.recruiterEmail && roleKey) {
        const match = this.database.prepare(`
          SELECT id FROM opportunities
          WHERE deleted_at IS NULL AND LOWER(recruiter_email) = LOWER(?) AND role_key = ?
          ORDER BY last_activity_at DESC LIMIT 1
        `).get(extracted.recruiterEmail, roleKey) as { id: number } | undefined;
        if (match) {
          opportunityId = match.id;
          linkReason = "dedupe_recruiter_role";
        }
      }

      const bounds = this.database.prepare(`
        SELECT MIN(internal_date_ms) first_ms, MAX(internal_date_ms) last_ms
        FROM emails WHERE thread_id = ?
      `).get(threadId) as { first_ms: number; last_ms: number };
      const firstContactAt = new Date(bounds.first_ms).toISOString();
      const lastActivityAt = new Date(bounds.last_ms).toISOString();
      const now = new Date().toISOString();

      if (!opportunityId) {
        const insert = this.database.prepare(`
          INSERT INTO opportunities(
            source, category, status, company, job_title, recruiter_name, recruiter_email,
            location, external_job_id, application_date, status_date, first_contact_at,
            last_activity_at, has_human_response, summary, confidence, extraction_provider,
            extraction_model, extraction_prompt_version, extraction_evidence_json, extracted_at,
            input_hash, company_key, role_key, created_at, updated_at
          ) VALUES ('gmail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          extracted.category,
          extracted.status,
          extracted.company,
          extracted.jobTitle,
          extracted.recruiterName,
          extracted.recruiterEmail,
          extracted.location,
          extracted.externalJobId,
          extracted.applicationDate,
          extracted.lastStatusDate,
          firstContactAt,
          lastActivityAt,
          extracted.hasHumanResponse ? 1 : 0,
          extracted.summary,
          extracted.confidence,
          result.provider,
          result.model,
          result.promptVersion,
          JSON.stringify(extracted.evidence),
          now,
          inputHash,
          companyKey,
          roleKey,
          now,
          now,
        );
        opportunityId = Number(insert.lastInsertRowid);
        this.insertTimeline(opportunityId, "created", now, "Opportunity detected", extracted.summary, null, { source: "gmail" });
      } else {
        const current = this.database.prepare(`
          SELECT *, 0 thread_count, 0 message_count FROM opportunities WHERE id = ?
        `).get(opportunityId) as unknown as OpportunityRow;
        const manual = new Set(parseJsonArray(current.manual_override_fields_json));
        const use = <T>(field: EditableField, detected: T, existing: T): T => manual.has(field) ? existing : detected;
        const canAdvanceStatus = !manual.has("status")
          && (!current.status_date || !extracted.lastStatusDate || extracted.lastStatusDate >= current.status_date);
        const category = use("category", extracted.category, current.category);
        const status = canAdvanceStatus ? extracted.status : current.status;
        const company = use("company", extracted.company, current.company);
        const jobTitle = use("jobTitle", extracted.jobTitle, current.job_title);
        const recruiterName = use("recruiterName", extracted.recruiterName, current.recruiter_name);
        const recruiterEmail = use("recruiterEmail", extracted.recruiterEmail, current.recruiter_email);
        const location = use("location", extracted.location, current.location);
        const applicationDate = manual.has("applicationDate")
          ? current.application_date
          : earliest(current.application_date, extracted.applicationDate);
        const summary = use("summary", extracted.summary, current.summary);
        this.database.prepare(`
          UPDATE opportunities SET
            category = ?, status = ?, company = ?, job_title = ?, recruiter_name = ?, recruiter_email = ?,
            location = ?, external_job_id = COALESCE(?, external_job_id), application_date = ?,
            status_date = ?, first_contact_at = ?, last_activity_at = ?, has_human_response = ?,
            summary = ?, confidence = ?, extraction_provider = ?, extraction_model = ?,
            extraction_prompt_version = ?, extraction_evidence_json = ?, extracted_at = ?, input_hash = ?,
            company_key = ?, role_key = ?, updated_at = ?
          WHERE id = ?
        `).run(
          category,
          status,
          company,
          jobTitle,
          recruiterName,
          recruiterEmail,
          location,
          extracted.externalJobId,
          applicationDate,
          canAdvanceStatus ? extracted.lastStatusDate : current.status_date,
          earliest(current.first_contact_at, firstContactAt),
          latest(current.last_activity_at, lastActivityAt),
          current.has_human_response || extracted.hasHumanResponse ? 1 : 0,
          summary,
          extracted.confidence,
          result.provider,
          result.model,
          result.promptVersion,
          JSON.stringify(extracted.evidence),
          now,
          inputHash,
          normalizeKey(company),
          normalizeKey(jobTitle),
          now,
          opportunityId,
        );
        if (status !== current.status) {
          this.insertTimeline(opportunityId, "status_changed", now, `Status changed to ${status}`, extracted.summary, null, { from: current.status, to: status, source: result.provider });
        }
      }

      this.database.prepare(`
        INSERT INTO opportunity_threads(opportunity_id, gmail_thread_id, link_reason, linked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(gmail_thread_id) DO UPDATE SET
          opportunity_id = excluded.opportunity_id,
          link_reason = excluded.link_reason
      `).run(opportunityId, threadId, linkReason, now);
      this.insertTimeline(opportunityId, "extracted", now, "Conversation analyzed", extracted.summary, null, {
        provider: result.provider,
        model: result.model,
        confidence: extracted.confidence,
        threadId,
        linkReason,
      });
      return opportunityId;
    });
  }

  createOpportunity(input: OpportunityCreateInput): OpportunityRecord {
    const now = new Date().toISOString();
    const fields = (Object.keys(input) as EditableField[]).filter((field) =>
      (EDITABLE_FIELDS as readonly string[]).includes(field),
    );
    const result = this.database.prepare(`
      INSERT INTO opportunities(
        source, category, status, company, job_title, recruiter_name, recruiter_email,
        location, application_date, first_contact_at, last_activity_at, summary, notes,
        company_key, role_key, manual_override_fields_json, created_at, updated_at
      ) VALUES ('manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.category,
      input.status,
      cleanText(input.company),
      cleanText(input.jobTitle),
      cleanText(input.recruiterName),
      cleanText(input.recruiterEmail)?.toLowerCase() ?? null,
      cleanText(input.location),
      input.applicationDate ?? null,
      input.applicationDate ? `${input.applicationDate}T00:00:00.000Z` : now,
      now,
      input.summary?.trim() ?? "",
      input.notes?.trim() ?? "",
      normalizeKey(input.company),
      normalizeKey(input.jobTitle),
      JSON.stringify([...new Set<EditableField>(["category", "status", ...fields])]),
      now,
      now,
    );
    const id = Number(result.lastInsertRowid);
    this.insertTimeline(id, "created", now, "Opportunity added", input.summary?.trim() ?? "Added manually", null, { source: "manual" });
    return this.getOpportunity(id)!;
  }

  updateOpportunity(id: number, input: OpportunityUpdateInput): OpportunityRecord | null {
    const currentRow = this.database.prepare(`${OPPORTUNITY_SELECT} WHERE o.id = ? AND o.deleted_at IS NULL GROUP BY o.id`).get(id) as OpportunityRow | undefined;
    if (!currentRow) return null;
    const current = mapOpportunity(currentRow);
    const entries = Object.entries(input) as Array<[EditableField, unknown]>;
    if (entries.length === 0) return current;
    const columnByField: Readonly<Record<EditableField, string>> = {
      category: "category",
      status: "status",
      company: "company",
      jobTitle: "job_title",
      recruiterName: "recruiter_name",
      recruiterEmail: "recruiter_email",
      location: "location",
      applicationDate: "application_date",
      summary: "summary",
      notes: "notes",
    };
    const manual = new Set<EditableField>(current.manualOverrideFields);
    const assignments: string[] = [];
    const parameters: Array<string | null> = [];
    for (const [field, rawValue] of entries) {
      if (!(EDITABLE_FIELDS as readonly string[]).includes(field)) continue;
      let value = rawValue as string | null;
      if (typeof value === "string") value = value.trim();
      if (["company", "jobTitle", "recruiterName", "recruiterEmail", "location", "applicationDate"].includes(field) && value === "") value = null;
      if (field === "recruiterEmail" && value) value = value.toLowerCase();
      assignments.push(`${columnByField[field]} = ?`);
      parameters.push(value);
      manual.add(field);
    }
    if (assignments.length === 0) return current;
    const now = new Date().toISOString();
    const nextCompany = "company" in input ? cleanText(input.company) : current.company;
    const nextRole = "jobTitle" in input ? cleanText(input.jobTitle) : current.jobTitle;
    assignments.push("company_key = ?", "role_key = ?", "manual_override_fields_json = ?", "last_activity_at = ?", "updated_at = ?");
    parameters.push(normalizeKey(nextCompany), normalizeKey(nextRole), JSON.stringify([...manual]), now, now);
    parameters.push(String(id));
    this.database.prepare(`UPDATE opportunities SET ${assignments.join(", ")} WHERE id = ?`).run(...parameters);

    const changedFields = entries.map(([field]) => field);
    if (input.status && input.status !== current.status) {
      this.insertTimeline(id, "status_changed", now, `Status changed to ${input.status}`, "Manual status override", null, { from: current.status, to: input.status, source: "manual" });
    } else {
      this.insertTimeline(id, "edited", now, "Opportunity updated", `Updated ${changedFields.join(", ")}`, null, { fields: changedFields });
    }
    return this.getOpportunity(id);
  }

  deleteOpportunity(id: number): boolean {
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE opportunities SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL
    `).run(now, now, id);
    return result.changes > 0;
  }

  listOpportunities(filters: OpportunityFilters = {}): readonly OpportunityRecord[] {
    const conditions = ["o.deleted_at IS NULL"];
    const parameters: string[] = [];
    if (filters.category) { conditions.push("o.category = ?"); parameters.push(filters.category); }
    if (filters.status) { conditions.push("o.status = ?"); parameters.push(filters.status); }
    if (filters.query) {
      conditions.push(`LOWER(COALESCE(o.company, '') || ' ' || COALESCE(o.job_title, '') || ' ' || COALESCE(o.recruiter_name, '') || ' ' || COALESCE(o.recruiter_email, '') || ' ' || o.summary || ' ' || o.notes) LIKE ?`);
      parameters.push(`%${filters.query.toLowerCase()}%`);
    }
    const rows = this.database.prepare(`
      ${OPPORTUNITY_SELECT}
      WHERE ${conditions.join(" AND ")}
      GROUP BY o.id
      ORDER BY o.last_activity_at DESC, o.id DESC
    `).all(...parameters) as unknown as OpportunityRow[];
    return rows.map(mapOpportunity);
  }

  getOpportunity(id: number): OpportunityRecord | null {
    const row = this.database.prepare(`
      ${OPPORTUNITY_SELECT} WHERE o.id = ? AND o.deleted_at IS NULL GROUP BY o.id
    `).get(id) as OpportunityRow | undefined;
    return row ? mapOpportunity(row) : null;
  }

  getOpportunityDetail(id: number): OpportunityDetail | null {
    const opportunity = this.getOpportunity(id);
    if (!opportunity) return null;
    const emails = this.database.prepare(`
      SELECT e.* FROM emails e
      INNER JOIN opportunity_threads ot ON ot.gmail_thread_id = e.thread_id
      WHERE ot.opportunity_id = ?
      ORDER BY e.internal_date_ms DESC
    `).all(id) as unknown as EmailRow[];
    const systemEvents = this.database.prepare(`
      SELECT * FROM timeline_events WHERE opportunity_id = ? ORDER BY occurred_at DESC
    `).all(id) as unknown as TimelineRow[];
    const emailEvents: TimelineEvent[] = emails.map((row) => ({
      id: `email:${row.gmail_message_id}`,
      type: row.direction === "outbound" ? "email_sent" : "email_received",
      occurredAt: new Date(row.internal_date_ms).toISOString(),
      title: row.subject || (row.direction === "outbound" ? "Email sent" : "Email received"),
      description: (row.snippet || row.body_text).replace(/\s+/g, " ").trim().slice(0, 500),
      direction: row.direction,
      messageId: row.gmail_message_id,
      metadata: {
        fromName: row.from_name,
        fromEmail: row.from_email,
        to: parseJsonArray(row.to_json),
        cc: parseJsonArray(row.cc_json),
      },
    }));
    const events: TimelineEvent[] = systemEvents.map((row) => ({
      id: `event:${row.id}`,
      type: row.event_type,
      occurredAt: row.occurred_at,
      title: row.title,
      description: row.description,
      direction: null,
      messageId: row.gmail_message_id,
      metadata: parseJsonObject(row.metadata_json),
    }));
    return {
      opportunity,
      timeline: [...emailEvents, ...events].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)),
      evidence: parseJsonArray((this.database.prepare("SELECT extraction_evidence_json value FROM opportunities WHERE id = ?").get(id) as { value: string }).value),
    };
  }

  getStats(): OpportunityStats {
    const records = this.listOpportunities();
    const byCategory: Record<OpportunityCategory, number> = { normal_application: 0, cold_email: 0, unsolicited: 0, phd: 0 };
    const byStatus: Record<OpportunityStatus, number> = {
      draft: 0,
      submitted: 0,
      awaiting_response: 0,
      replied: 0,
      screening: 0,
      assessment: 0,
      interview: 0,
      offer: 0,
      accepted: 0,
      rejected: 0,
      withdrawn: 0,
      closed: 0,
    };
    records.forEach((record) => {
      byCategory[record.category] += 1;
      byStatus[record.status] += 1;
    });
    const responseRows = this.database.prepare(`
      SELECT o.id, o.has_human_response
      FROM opportunities o
      WHERE o.deleted_at IS NULL AND o.source = 'gmail'
        AND EXISTS (
          SELECT 1 FROM opportunity_threads ot
          INNER JOIN emails e ON e.thread_id = ot.gmail_thread_id
          WHERE ot.opportunity_id = o.id AND e.direction = 'outbound'
        )
    `).all() as unknown as Array<{ id: number; has_human_response: number }>;
    const responseRate = responseRows.length === 0
      ? 0
      : Math.round((responseRows.filter((row) => row.has_human_response === 1).length / responseRows.length) * 1_000) / 10;
    const terminal = new Set<OpportunityStatus>(["accepted", "rejected", "withdrawn", "closed"]);
    return {
      total: records.length,
      active: records.filter((record) => !terminal.has(record.status) && record.status !== "draft").length,
      waiting: byStatus.submitted + byStatus.awaiting_response,
      interviews: byStatus.interview,
      offers: byStatus.offer + byStatus.accepted,
      rejections: byStatus.rejected,
      responseRate,
      byCategory,
      byStatus,
    };
  }

  getSyncState(extractionConfigured: boolean): SyncState {
    const tokens = this.getOAuthTokens();
    const opportunities = this.database.prepare("SELECT COUNT(*) count FROM opportunities WHERE deleted_at IS NULL").get() as { count: number };
    const pending = this.database.prepare(`
      SELECT COUNT(DISTINCT e.thread_id) count FROM emails e
      WHERE e.internal_date_ms >= COALESCE(
        CAST((SELECT value FROM app_settings WHERE key = 'analysis_min_internal_date_ms') AS INTEGER),
        0
      )
      AND NOT EXISTS (
        SELECT 1 FROM extraction_runs r WHERE r.gmail_thread_id = e.thread_id AND r.status = 'success'
      )
    `).get() as { count: number };
    return {
      connected: Boolean(tokens?.refresh_token || tokens?.access_token),
      emailAddress: this.getSetting("gmail_email_address"),
      initialSyncComplete: this.getSetting("initial_sync_complete") === "true",
      lastSyncAt: this.getSetting("last_sync_at"),
      storedMessageCount: this.countEmails(),
      opportunityCount: opportunities.count,
      extractionConfigured,
      pendingThreadCount: pending.count,
    };
  }

  private insertTimeline(
    opportunityId: number,
    type: Exclude<TimelineEventType, "email_received" | "email_sent">,
    occurredAt: string,
    title: string,
    description: string,
    messageId: string | null,
    metadata: Readonly<Record<string, unknown>>,
  ): void {
    this.database.prepare(`
      INSERT INTO timeline_events(opportunity_id, event_type, occurred_at, title, description, gmail_message_id, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(opportunityId, type, occurredAt, title, description, messageId, JSON.stringify(metadata));
  }

  close(): void { this.database.close(); }
}

export function isOpportunityCategory(value: string): value is OpportunityCategory {
  return (OPPORTUNITY_CATEGORIES as readonly string[]).includes(value);
}

export function isOpportunityStatus(value: string): value is OpportunityStatus {
  return (OPPORTUNITY_STATUSES as readonly string[]).includes(value);
}
