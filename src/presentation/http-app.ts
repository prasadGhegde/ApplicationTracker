import type { Express, NextFunction, Request, Response } from "express";
import express from "express";
import { z, ZodError } from "zod";
import type { OpportunityAnalyzer, OpportunityExtractionService, TrackerStore } from "../application/ports.js";
import { GmailSyncService } from "../application/sync-service.js";
import { OPPORTUNITY_CATEGORIES, OPPORTUNITY_STATUSES } from "../domain/models.js";
import type { AppConfig } from "../config.js";
import { GMAIL_READONLY_SCOPE, GoogleAuthService } from "../infrastructure/google-auth.js";
import { OpenAIOpportunityExtractor } from "../infrastructure/openai-extractor.js";
import { RuntimeCredentialStore } from "../infrastructure/runtime-credentials.js";

const nullableText = z.string().trim().max(500).nullable().optional();
const nullableEmail = z.union([z.string().trim().email().max(320), z.literal(""), z.null()]).optional()
  .transform((value) => value === "" ? null : value);
const nullableDate = z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal(""), z.null()]).optional()
  .transform((value) => value === "" ? null : value);

const opportunityInputSchema = z.object({
  category: z.enum(OPPORTUNITY_CATEGORIES),
  status: z.enum(OPPORTUNITY_STATUSES),
  company: nullableText,
  jobTitle: nullableText,
  recruiterName: nullableText,
  recruiterEmail: nullableEmail,
  location: nullableText,
  applicationDate: nullableDate,
  summary: z.string().trim().max(2_000).optional(),
  notes: z.string().trim().max(10_000).optional(),
}).strict();

const opportunityUpdateSchema = opportunityInputSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one editable field is required.",
);

const analysisInputSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
  force: z.boolean().default(false),
}).strict();
const initialSyncInputSchema = z.object({
  analysisLimit: z.union([z.literal(50), z.literal(100), z.literal(150), z.literal(200), z.literal(250)]),
}).strict();
const settingsInputSchema = z.object({
  gmailClientId: z.string().trim().max(500).optional(),
  gmailClientSecret: z.string().trim().max(500).optional(),
  openaiApiKey: z.string().trim().max(500).optional(),
}).strict().refine((value) => Object.values(value).some((item) => item), "Enter at least one credential.");

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.cookie ?? "";
  for (const item of header.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return null;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return message
    .replace(/AQ\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
}

function requireLocalMutation(config: AppConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.headers.origin;
    if ((origin && !config.trustedOrigins.has(origin)) || request.header("X-Opportunity-Desk") !== "1") {
      response.status(403).json({ error: "Request origin rejected." });
      return;
    }
    next();
  };
}

export function createHttpApp(
  config: AppConfig,
  store: TrackerStore,
  auth: GoogleAuthService,
  syncService: GmailSyncService,
  analyzer: OpportunityAnalyzer,
  extractor: OpenAIOpportunityExtractor,
  credentials: RuntimeCredentialStore,
): Express {
  const app = express();
  const mutationGuard = requireLocalMutation(config);
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com",
    );
    next();
  });
  app.use(express.json({ limit: "32kb" }));

  app.get("/auth/google", async (_request, response, next) => {
    try {
      const authorization = await auth.beginAuthorization();
      response.setHeader("Set-Cookie", `gmail_oauth_state=${encodeURIComponent(authorization.state)}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/`);
      response.redirect(authorization.url);
    } catch (error) { next(error); }
  });

  app.get("/oauth2/callback", async (request, response, next) => {
    try {
      const code = queryString(request.query.code);
      const state = queryString(request.query.state);
      const expectedState = cookieValue(request, "gmail_oauth_state");
      if (!code || !state || !expectedState || state !== expectedState) {
        response.status(400).type("text/plain").send("Google authorization failed: invalid state or missing code.");
        return;
      }
      await auth.completeAuthorization(code, state);
      response.setHeader("Set-Cookie", "gmail_oauth_state=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/");
      response.redirect("/?connected=1");
    } catch (error) { next(error); }
  });

  app.get("/api/state", (_request, response) => {
    response.json({
      ...store.getSyncState(extractor.isConfigured()),
      gmailScope: GMAIL_READONLY_SCOPE,
      extractionProvider: extractor.provider,
      extractionModel: extractor.model,
      gmailConfigured: auth.isConfigured(),
    });
  });

  app.get("/api/stats", (_request, response) => response.json(store.getStats()));

  app.get("/api/settings", (_request, response) => {
    response.json({ ...credentials.status(), oauthRedirectUri: config.oauthRedirectUri, openaiModel: extractor.model });
  });

  app.post("/api/settings", mutationGuard, (request, response, next) => {
    try {
      const input = settingsInputSchema.parse(request.body);
      const before = credentials.read();
      const updated = credentials.update(input);
      const gmailChanged = updated.gmailClientId !== before.gmailClientId || updated.gmailClientSecret !== before.gmailClientSecret;
      if (gmailChanged) auth.disconnectLocally();
      auth.configure(updated.gmailClientId, updated.gmailClientSecret);
      extractor.configure(updated.openaiApiKey);
      response.json({ ...credentials.status(), oauthRedirectUri: config.oauthRedirectUri, openaiModel: extractor.model });
    } catch (error) { next(error); }
  });

  app.get("/api/opportunities", (request, response) => {
    const category = queryString(request.query.category);
    const status = queryString(request.query.status);
    if (category && !(OPPORTUNITY_CATEGORIES as readonly string[]).includes(category)) {
      response.status(400).json({ error: "Invalid category filter." });
      return;
    }
    if (status && !(OPPORTUNITY_STATUSES as readonly string[]).includes(status)) {
      response.status(400).json({ error: "Invalid status filter." });
      return;
    }
    response.json(store.listOpportunities({
      category: category as (typeof OPPORTUNITY_CATEGORIES)[number] | undefined,
      status: status as (typeof OPPORTUNITY_STATUSES)[number] | undefined,
      query: queryString(request.query.q),
    }));
  });

  app.post("/api/opportunities", mutationGuard, (request, response, next) => {
    try {
      const input = opportunityInputSchema.parse(request.body);
      response.status(201).json(store.createOpportunity(input));
    } catch (error) { next(error); }
  });

  app.get("/api/opportunities/:id", (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      response.status(400).json({ error: "Invalid opportunity ID." });
      return;
    }
    const detail = store.getOpportunityDetail(id);
    if (!detail) {
      response.status(404).json({ error: "Opportunity not found." });
      return;
    }
    response.json(detail);
  });

  app.patch("/api/opportunities/:id", mutationGuard, (request, response, next) => {
    try {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        response.status(400).json({ error: "Invalid opportunity ID." });
        return;
      }
      const updated = store.updateOpportunity(id, opportunityUpdateSchema.parse(request.body));
      if (!updated) {
        response.status(404).json({ error: "Opportunity not found." });
        return;
      }
      response.json(updated);
    } catch (error) { next(error); }
  });

  app.delete("/api/opportunities/:id", mutationGuard, (request, response) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      response.status(400).json({ error: "Invalid opportunity ID." });
      return;
    }
    if (!store.deleteOpportunity(id)) {
      response.status(404).json({ error: "Opportunity not found." });
      return;
    }
    response.json({ deleted: true });
  });

  app.post("/api/sync/initial", mutationGuard, async (request, response, next) => {
    try {
      if (!auth.isConnected()) {
        response.status(401).json({ error: "Connect Gmail before syncing." });
        return;
      }
      if (!extractor.isConfigured()) {
        response.status(503).json({ error: "Add an OpenAI API key in Settings first." });
        return;
      }
      const input = initialSyncInputSchema.parse(request.body ?? {});
      response.json(await syncService.initialSync(input.analysisLimit));
    } catch (error) { next(error); }
  });

  app.post("/api/sync/incremental", mutationGuard, async (_request, response, next) => {
    try {
      if (!auth.isConnected()) {
        response.status(401).json({ error: "Connect Gmail before syncing." });
        return;
      }
      response.json(await syncService.syncNew());
    } catch (error) { next(error); }
  });

  app.post("/api/analyze", mutationGuard, async (request, response, next) => {
    try {
      if (!extractor.isConfigured()) {
        response.status(503).json({ error: "Add an OpenAI API key in Settings first." });
        return;
      }
      const input = analysisInputSchema.parse(request.body ?? {});
      const threadIds = store.getPendingThreadIds(input.limit);
      response.json(await analyzer.analyzeThreads(threadIds, input.force));
    } catch (error) { next(error); }
  });

  app.post("/api/auth/disconnect", mutationGuard, (_request, response) => {
    auth.disconnectLocally();
    response.json({ disconnected: true });
  });

  app.use(express.static(config.publicDir, { extensions: ["html"], etag: true, maxAge: "5m" }));

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: "Invalid request.", issues: error.issues });
      return;
    }
    const message = safeErrorMessage(error);
    console.error(`[request-error] ${message}`);
    response.status(500).json({ error: message });
  });
  return app;
}
