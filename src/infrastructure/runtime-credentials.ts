import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RuntimeCredentials {
  readonly gmailClientId: string | null;
  readonly gmailClientSecret: string | null;
  readonly openaiApiKey: string | null;
}

interface StoredCredentials {
  readonly gmailClientId?: string;
  readonly gmailClientSecret?: string;
  readonly openaiApiKey?: string;
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readLegacyGoogleCredentials(credentialsPath: string | null): Pick<RuntimeCredentials, "gmailClientId" | "gmailClientSecret"> {
  if (!credentialsPath || !existsSync(credentialsPath)) return { gmailClientId: null, gmailClientSecret: null };
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, "utf8")) as {
      installed?: { client_id?: string; client_secret?: string };
      web?: { client_id?: string; client_secret?: string };
    };
    const client = parsed.installed ?? parsed.web;
    return { gmailClientId: clean(client?.client_id), gmailClientSecret: clean(client?.client_secret) };
  } catch {
    return { gmailClientId: null, gmailClientSecret: null };
  }
}

export class RuntimeCredentialStore {
  constructor(
    private readonly filePath: string,
    private readonly legacyGoogleCredentialsPath: string | null,
  ) {}

  read(): RuntimeCredentials {
    let stored: StoredCredentials = {};
    if (existsSync(this.filePath)) {
      try { stored = JSON.parse(readFileSync(this.filePath, "utf8")) as StoredCredentials; } catch { stored = {}; }
    }
    const legacy = readLegacyGoogleCredentials(this.legacyGoogleCredentialsPath);
    return {
      gmailClientId: clean(stored.gmailClientId) ?? clean(process.env.GMAIL_CLIENT_ID) ?? legacy.gmailClientId,
      gmailClientSecret: clean(stored.gmailClientSecret) ?? clean(process.env.GMAIL_CLIENT_SECRET) ?? legacy.gmailClientSecret,
      openaiApiKey: clean(stored.openaiApiKey) ?? clean(process.env.OPENAI_API_KEY),
    };
  }

  update(input: Partial<RuntimeCredentials>): RuntimeCredentials {
    const current = this.read();
    const updated: RuntimeCredentials = {
      gmailClientId: clean(input.gmailClientId) ?? current.gmailClientId,
      gmailClientSecret: clean(input.gmailClientSecret) ?? current.gmailClientSecret,
      openaiApiKey: clean(input.openaiApiKey) ?? current.openaiApiKey,
    };
    mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
    chmodSync(this.filePath, 0o600);
    return updated;
  }

  status(): { gmailConfigured: boolean; openaiConfigured: boolean; gmailClientId: string | null } {
    const credentials = this.read();
    return {
      gmailConfigured: Boolean(credentials.gmailClientId && credentials.gmailClientSecret),
      openaiConfigured: Boolean(credentials.openaiApiKey),
      gmailClientId: credentials.gmailClientId,
    };
  }
}
