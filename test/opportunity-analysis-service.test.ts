import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { OpportunityExtractionService } from "../src/application/ports.js";
import { OpportunityAnalysisService } from "../src/application/opportunity-analysis-service.js";
import type { ExtractionResult, OpportunityConversation, StoredEmail } from "../src/domain/models.js";
import { SqliteTrackerStore } from "../src/infrastructure/database.js";

const temporaryDirectories: string[] = [];

function createStore(): SqliteTrackerStore {
  const directory = mkdtempSync(path.join(tmpdir(), "opportunity-desk-test-"));
  temporaryDirectories.push(directory);
  const store = new SqliteTrackerStore(path.join(directory, "test.sqlite"));
  store.setSetting("gmail_email_address", "me@example.com");
  return store;
}

function email(id: string, threadId: string, direction: "inbound" | "outbound", day: number): StoredEmail {
  return {
    gmailMessageId: id,
    threadId,
    historyId: String(day),
    internalDateMs: Date.parse(`2026-08-${String(day).padStart(2, "0")}T10:00:00Z`),
    direction,
    labelIds: [direction === "outbound" ? "SENT" : "INBOX"],
    subject: "Application for Robotics Engineer at Acme",
    fromName: direction === "outbound" ? "Me" : "Alex Recruiter",
    fromEmail: direction === "outbound" ? "me@example.com" : "alex@acme.com",
    to: direction === "outbound" ? ["alex@acme.com"] : ["me@example.com"],
    cc: [],
    replyTo: null,
    messageIdHeader: `<${id}@example.com>`,
    inReplyTo: null,
    references: [],
    listUnsubscribe: null,
    snippet: direction === "outbound" ? "Please consider my application." : "Thank you for applying.",
    bodyText: direction === "outbound" ? "My application is attached." : "We received your application.",
    fetchedAt: "2026-08-03T10:00:00Z",
  };
}

function result(overrides: Partial<ExtractionResult["extraction"]> = {}): ExtractionResult {
  const extraction = {
    isOpportunity: true,
    category: "normal_application" as const,
    status: "submitted" as const,
    company: "Acme",
    jobTitle: "Robotics Engineer",
    recruiterName: "Alex Recruiter",
    recruiterEmail: "alex@acme.com",
    location: "Zurich",
    externalJobId: "R-42",
    applicationDate: "2026-08-01",
    lastStatusDate: "2026-08-02",
    hasHumanResponse: false,
    summary: "Application submitted for Robotics Engineer at Acme; receipt confirmed.",
    confidence: 0.95,
    evidence: ["Subject names role and company", "Recruiter signature"],
    ...overrides,
  };
  return { extraction, provider: "test", model: "test-model", promptVersion: "test-v1", rawResult: extraction };
}

class FakeExtractor implements OpportunityExtractionService {
  readonly provider = "test";
  readonly model = "test-model";
  readonly promptVersion = "test-v1";
  next = result();
  isConfigured(): boolean { return true; }
  async extract(_conversation: OpportunityConversation): Promise<ExtractionResult> { return this.next; }
}

afterEach(() => {
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()!;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Opportunity analysis and persistence", () => {
  it("merges sent and inbox mail into one opportunity and builds a timeline", async () => {
    const store = createStore();
    store.upsertEmails([email("sent-1", "thread-1", "outbound", 1), email("inbox-1", "thread-1", "inbound", 2)]);
    const analyzer = new OpportunityAnalysisService(store, new FakeExtractor());

    const outcome = await analyzer.analyzeThreads(["thread-1"]);
    assert.equal(outcome.opportunitiesUpdated, 1);
    const records = store.listOpportunities();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.messageCount, 2);
    assert.equal(records[0]?.threadCount, 1);
    const detail = store.getOpportunityDetail(records[0]!.id);
    assert.ok(detail);
    assert.equal(detail.timeline.filter((event) => event.type === "email_sent").length, 1);
    assert.equal(detail.timeline.filter((event) => event.type === "email_received").length, 1);
    store.close();
  });

  it("deduplicates separate Gmail threads for the same company and role", async () => {
    const store = createStore();
    store.upsertEmails([email("sent-1", "thread-1", "outbound", 1), email("inbox-2", "thread-2", "inbound", 3)]);
    const analyzer = new OpportunityAnalysisService(store, new FakeExtractor());

    await analyzer.analyzeThreads(["thread-1", "thread-2"]);
    const records = store.listOpportunities();
    assert.equal(records.length, 1);
    assert.equal(records[0]?.threadCount, 2);
    assert.equal(records[0]?.messageCount, 2);
    store.close();
  });

  it("preserves manual overrides during later extraction", async () => {
    const store = createStore();
    store.upsertEmails([email("sent-1", "thread-1", "outbound", 1)]);
    const extractor = new FakeExtractor();
    const analyzer = new OpportunityAnalysisService(store, extractor);
    await analyzer.analyzeThreads(["thread-1"]);
    const record = store.listOpportunities()[0]!;
    store.updateOpportunity(record.id, { company: "ACME Robotics", status: "interview" });

    extractor.next = result({ company: "Wrong Company", status: "rejected", lastStatusDate: "2026-08-04" });
    await analyzer.analyzeThreads(["thread-1"], true);
    const updated = store.getOpportunity(record.id)!;
    assert.equal(updated.company, "ACME Robotics");
    assert.equal(updated.status, "interview");
    assert.deepEqual(new Set(updated.manualOverrideFields), new Set(["company", "status"]));
    store.close();
  });

  it("supports manual create, update, and soft delete", () => {
    const store = createStore();
    const created = store.createOpportunity({
      category: "phd",
      status: "draft",
      company: "Technical University",
      jobTitle: "PhD in Digital Twins",
    });
    assert.equal(store.listOpportunities().length, 1);
    const updated = store.updateOpportunity(created.id, { status: "submitted", notes: "Submitted through portal" });
    assert.equal(updated?.status, "submitted");
    assert.equal(updated?.notes, "Submitted through portal");
    assert.equal(store.deleteOpportunity(created.id), true);
    assert.equal(store.listOpportunities().length, 0);
    store.close();
  });
});
