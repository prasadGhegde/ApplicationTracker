import { createHash } from "node:crypto";
import type {
  OpportunityAnalyzer,
  OpportunityExtractionService,
  TrackerStore,
} from "./ports.js";
import type { AnalysisBatchResult, OpportunityConversation } from "../domain/models.js";

function conversationHash(
  conversation: OpportunityConversation,
  extractor: OpportunityExtractionService,
): string {
  const hash = createHash("sha256");
  hash.update(extractor.provider);
  hash.update("\0");
  hash.update(extractor.model);
  hash.update("\0");
  hash.update(extractor.promptVersion);
  for (const message of conversation.messages) {
    hash.update("\0");
    hash.update(message.id);
    hash.update("\0");
    hash.update(message.direction);
    hash.update("\0");
    hash.update(message.sentAt);
    hash.update("\0");
    hash.update(message.subject);
    hash.update("\0");
    hash.update(message.fromEmail ?? "");
    hash.update("\0");
    hash.update(message.to.join(","));
    hash.update("\0");
    hash.update(message.bodyText);
  }
  return hash.digest("hex");
}

function safeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown extraction failure";
  return message
    .replace(/AQ\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 1_000);
}

export class OpportunityAnalysisService implements OpportunityAnalyzer {
  constructor(
    private readonly store: TrackerStore,
    private readonly extractor: OpportunityExtractionService,
  ) {}

  async analyzeThreads(threadIds: readonly string[], force = false): Promise<AnalysisBatchResult> {
    if (!this.extractor.isConfigured()) {
      throw new Error("Add an OpenAI API key in Settings before analysis.");
    }

    let analyzedThreads = 0;
    let opportunitiesUpdated = 0;
    let notOpportunities = 0;
    let skippedUnchanged = 0;
    let failures = 0;

    for (const threadId of [...new Set(threadIds)]) {
      const conversation = this.store.getConversation(threadId);
      if (!conversation || conversation.messages.length === 0) continue;
      const inputHash = conversationHash(conversation, this.extractor);
      if (!force && this.store.getSuccessfulExtractionHash(threadId) === inputHash) {
        skippedUnchanged += 1;
        continue;
      }

      const runId = this.store.beginExtractionRun(
        threadId,
        inputHash,
        this.extractor.provider,
        this.extractor.model,
        this.extractor.promptVersion,
      );
      try {
        const result = await this.extractor.extract(conversation);
        const opportunityId = this.store.applyExtraction(threadId, inputHash, result);
        this.store.completeExtractionRun(runId, result, opportunityId);
        analyzedThreads += 1;
        if (opportunityId) opportunitiesUpdated += 1;
        else notOpportunities += 1;
      } catch (error) {
        failures += 1;
        this.store.failExtractionRun(runId, safeFailureMessage(error));
      }
    }

    return {
      requestedThreads: new Set(threadIds).size,
      analyzedThreads,
      opportunitiesUpdated,
      notOpportunities,
      skippedUnchanged,
      failures,
    };
  }
}

export { conversationHash };
