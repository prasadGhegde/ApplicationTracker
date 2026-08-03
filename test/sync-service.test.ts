import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { GmailGateway, GmailProfile } from "../src/application/ports.js";
import { GmailSyncService } from "../src/application/sync-service.js";
import type { StoredEmail } from "../src/domain/models.js";
import { SqliteTrackerStore } from "../src/infrastructure/database.js";

function email(id: string, threadId: string, direction: "inbound" | "outbound", day: number): StoredEmail {
  return {
    gmailMessageId: id,
    threadId,
    historyId: String(day),
    internalDateMs: Date.parse(`2026-08-0${day}T10:00:00Z`),
    direction,
    labelIds: [direction === "outbound" ? "SENT" : "INBOX"],
    subject: "Application update",
    fromName: direction === "outbound" ? "Me" : "Recruiter",
    fromEmail: direction === "outbound" ? "me@example.com" : "recruiter@example.com",
    to: direction === "outbound" ? ["recruiter@example.com"] : ["me@example.com"],
    cc: [],
    replyTo: null,
    messageIdHeader: `<${id}@example.com>`,
    inReplyTo: null,
    references: [],
    listUnsubscribe: null,
    snippet: "Application update",
    bodyText: "Application update",
    fetchedAt: "2026-08-03T10:00:00Z",
  };
}

class FakeGateway implements GmailGateway {
  readonly fetchedIds: string[] = [];
  readonly listCalls: Array<{ label: "INBOX" | "SENT"; limit: number }> = [];
  readonly historyCalls: string[] = [];
  historyIds: string[] = [];
  readonly messages = new Map<string, StoredEmail>([
    ["inbox-1", email("inbox-1", "thread-1", "inbound", 1)],
    ["sent-1", email("sent-1", "thread-1", "outbound", 1)],
    ["inbox-2", email("inbox-2", "thread-1", "inbound", 2)],
  ]);
  async getProfile(): Promise<GmailProfile> { return { emailAddress: "me@example.com", historyId: "100" }; }
  async listMessageIds(label: "INBOX" | "SENT", limit: number): Promise<readonly string[]> {
    this.listCalls.push({ label, limit });
    return label === "INBOX" ? ["inbox-1"] : ["sent-1"];
  }
  async listAddedMessageIds(startHistoryId: string): Promise<{ ids: readonly string[]; latestHistoryId: string }> {
    this.historyCalls.push(startHistoryId);
    return { ids: this.historyIds, latestHistoryId: "105" };
  }
  async getMessage(id: string): Promise<StoredEmail> {
    this.fetchedIds.push(id);
    return this.messages.get(id)!;
  }
}

describe("GmailSyncService", () => {
  it("performs a bounded first sync and fetches only unseen history messages later", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "opportunity-desk-sync-"));
    const store = new SqliteTrackerStore(path.join(directory, "test.sqlite"));
    const gateway = new FakeGateway();
    const service = new GmailSyncService(() => gateway, store, null);
    try {
      const first = await service.initialSync();
      assert.equal(first.mode, "initial");
      assert.deepEqual(gateway.listCalls, [{ label: "INBOX", limit: 250 }, { label: "SENT", limit: 30 }]);
      assert.deepEqual(gateway.fetchedIds.sort(), ["inbox-1", "sent-1"]);
      assert.equal(store.countEmails(), 2);

      gateway.historyIds = ["inbox-1", "inbox-2"];
      const incremental = await service.syncNew();
      assert.equal(incremental.mode, "incremental");
      assert.deepEqual(gateway.fetchedIds.sort(), ["inbox-1", "inbox-2", "sent-1"]);
      assert.equal(incremental.newMessagesStored, 1);
      assert.equal(store.countEmails(), 3);

      gateway.historyIds = [];
      const unchanged = await service.syncNew();
      assert.equal(unchanged.newMessagesStored, 0);
      assert.deepEqual(gateway.fetchedIds.sort(), ["inbox-1", "inbox-2", "sent-1"]);
      assert.deepEqual(gateway.historyCalls, ["100", "105"]);
      await assert.rejects(() => service.initialSync(), /already complete/);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
