import { randomBytes } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import type { TrackerStore } from "../application/ports.js";
import type { OAuthTokens } from "../domain/models.js";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

interface PendingAuthorization {
  readonly codeVerifier: string;
  readonly createdAt: number;
}

export class GoogleAuthService {
  private client: OAuth2Client | null = null;
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(
    private readonly redirectUri: string,
    private readonly store: TrackerStore,
    clientId: string | null,
    clientSecret: string | null,
  ) {
    this.configure(clientId, clientSecret);
  }

  configure(clientId: string | null, clientSecret: string | null): void {
    if (!clientId || !clientSecret) {
      this.client = null;
      return;
    }
    const client = new OAuth2Client(clientId, clientSecret, this.redirectUri);
    const storedTokens = this.store.getOAuthTokens();
    if (storedTokens) {
      client.setCredentials(storedTokens);
    }
    client.on("tokens", (tokens) => {
      this.store.saveOAuthTokens(tokens as OAuthTokens);
    });
    this.client = client;
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  isConnected(): boolean {
    const tokens = this.store.getOAuthTokens();
    return Boolean(tokens?.refresh_token || tokens?.access_token);
  }

  getClient(): OAuth2Client {
    if (!this.client) throw new Error("Add the Gmail client ID and client secret in Settings first.");
    const storedTokens = this.store.getOAuthTokens();
    if (!storedTokens) {
      throw new Error("Gmail is not connected. Complete Google authorization first.");
    }
    this.client.setCredentials(storedTokens);
    return this.client;
  }

  async beginAuthorization(): Promise<{ url: string; state: string }> {
    if (!this.client) throw new Error("Add the Gmail client ID and client secret in Settings first.");
    this.removeExpiredPendingStates();
    const state = randomBytes(24).toString("base64url");
    const { codeVerifier, codeChallenge } = await this.client.generateCodeVerifierAsync();
    this.pending.set(state, { codeVerifier, createdAt: Date.now() });
    const url = this.client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [GMAIL_READONLY_SCOPE],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    return { url, state };
  }

  async completeAuthorization(code: string, state: string): Promise<void> {
    if (!this.client) throw new Error("Gmail OAuth is not configured.");
    this.removeExpiredPendingStates();
    const pending = this.pending.get(state);
    if (!pending) {
      throw new Error("The OAuth state is missing or expired. Start the connection again.");
    }
    this.pending.delete(state);
    const { tokens } = await this.client.getToken({ code, codeVerifier: pending.codeVerifier });
    this.client.setCredentials(tokens);
    this.store.saveOAuthTokens(tokens as OAuthTokens);
  }

  disconnectLocally(): void {
    this.client?.setCredentials({});
    this.store.clearOAuthTokens();
  }

  private removeExpiredPendingStates(): void {
    const cutoff = Date.now() - 10 * 60 * 1_000;
    for (const [state, pending] of this.pending) {
      if (pending.createdAt < cutoff) this.pending.delete(state);
    }
  }
}

export { GMAIL_READONLY_SCOPE };
