import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { conversationHash } from "../application/opportunity-analysis-service.js";
import { SqliteTrackerStore } from "../infrastructure/database.js";
import { OpenAIOpportunityExtractor } from "../infrastructure/openai-extractor.js";
import { RuntimeCredentialStore } from "../infrastructure/runtime-credentials.js";

process.umask(0o077);

const EMAIL_SAMPLE_LIMIT = 10;
const config = loadConfig();
const store = new SqliteTrackerStore(config.databasePath);
const credentials = new RuntimeCredentialStore(config.runtimeCredentialsPath, config.legacyCredentialsPath).read();
const extractor = new OpenAIOpportunityExtractor(credentials.openaiApiKey, config.openaiModel);

if (!extractor.isConfigured()) {
  console.error("OPENAI_API_KEY is not set. Export it in this shell, then rerun npm run test:extraction.");
  store.close();
  process.exit(1);
}

const threadIds = store.getRecentThreadIdsByMessageLimit(EMAIL_SAMPLE_LIMIT);
const results: Array<Record<string, unknown>> = [];
for (const threadId of threadIds) {
  const conversation = store.getConversation(threadId);
  if (!conversation) continue;
  const inputHash = conversationHash(conversation, extractor);
  const runId = store.beginExtractionRun(threadId, inputHash, extractor.provider, extractor.model, extractor.promptVersion);
  try {
    const result = await extractor.extract(conversation);
    const opportunityId = store.applyExtraction(threadId, inputHash, result);
    store.completeExtractionRun(runId, result, opportunityId);
    results.push({
      threadId,
      conversationMessageCount: conversation.messages.length,
      opportunityId,
      ...result.extraction,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown error")
      .replace(/AQ\.[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
    store.failExtractionRun(runId, message);
    results.push({
      threadId,
      conversationMessageCount: conversation.messages.length,
      error: message,
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  seedEmailCount: EMAIL_SAMPLE_LIMIT,
  uniqueConversationCount: threadIds.length,
  model: config.openaiModel,
  results,
};
const reportDirectory = path.join(process.cwd(), "local-data");
mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
const reportPath = path.join(reportDirectory, "openai-extraction-test-10.json");
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
chmodSync(reportPath, 0o600);
console.log(JSON.stringify({
  seedEmailCount: EMAIL_SAMPLE_LIMIT,
  uniqueConversationCount: threadIds.length,
  successfulExtractions: results.filter((result) => !("error" in result)).length,
  failures: results.filter((result) => "error" in result).length,
  reportPath: path.relative(process.cwd(), reportPath),
}));
store.close();
