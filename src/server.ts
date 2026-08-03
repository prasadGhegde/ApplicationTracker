import { loadConfig } from "./config.js";
import { OpportunityAnalysisService } from "./application/opportunity-analysis-service.js";
import { GmailSyncService } from "./application/sync-service.js";
import { SqliteTrackerStore } from "./infrastructure/database.js";
import { OpenAIOpportunityExtractor } from "./infrastructure/openai-extractor.js";
import { GoogleAuthService } from "./infrastructure/google-auth.js";
import { GoogleGmailGateway } from "./infrastructure/gmail-gateway.js";
import { createHttpApp } from "./presentation/http-app.js";
import { RuntimeCredentialStore } from "./infrastructure/runtime-credentials.js";

process.umask(0o077);

const config = loadConfig();
const store = new SqliteTrackerStore(config.databasePath);
const credentials = new RuntimeCredentialStore(config.runtimeCredentialsPath, config.legacyCredentialsPath);
const initialCredentials = credentials.read();
const auth = new GoogleAuthService(
  config.oauthRedirectUri,
  store,
  initialCredentials.gmailClientId,
  initialCredentials.gmailClientSecret,
);
const extractor = new OpenAIOpportunityExtractor(initialCredentials.openaiApiKey, config.openaiModel);
const analyzer = new OpportunityAnalysisService(store, extractor);
const syncService = new GmailSyncService(
  () => new GoogleGmailGateway(auth.getClient()),
  store,
  analyzer,
);
const app = createHttpApp(config, store, auth, syncService, analyzer, extractor, credentials);

const server = app.listen(config.port, config.host, () => {
  console.log(`Opportunity Desk: ${config.baseUrl}`);
  console.log(`Structured extraction: ${extractor.isConfigured() ? extractor.model : "not configured"}`);
});

server.on("error", (error) => {
  console.error(`Opportunity Desk could not start: ${error.message}`);
  store.close();
  process.exitCode = 1;
});

let closing = false;
const shutDown = (): void => {
  if (closing) return;
  closing = true;
  server.close(() => {
    store.close();
    process.exit(0);
  });
};

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
