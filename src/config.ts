import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export interface AppConfig {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly baseUrl: string;
  readonly trustedOrigins: ReadonlySet<string>;
  readonly oauthRedirectUri: string;
  readonly legacyCredentialsPath: string | null;
  readonly runtimeCredentialsPath: string;
  readonly databasePath: string;
  readonly publicDir: string;
  readonly openaiModel: string;
}

function parsePort(raw: string | undefined): number {
  const value = raw ? Number(raw) : 3000;
  if (!Number.isInteger(value) || value < 1024 || value > 65_535) {
    throw new Error("PORT must be an integer between 1024 and 65535.");
  }
  return value;
}

function findCredentialsPath(root: string): string | null {
  const configured = process.env.GMAIL_CREDENTIALS_PATH;
  if (configured) {
    const resolved = path.resolve(configured);
    if (!existsSync(resolved)) {
      return null;
    }
    return resolved;
  }

  const matches = readdirSync(root)
    .filter((name) => name.startsWith("client_secret_") && name.endsWith(".json"))
    .sort();
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    return null;
  }
  return path.join(root, matches[0]!);
}

export function loadConfig(): AppConfig {
  const root = process.cwd();
  const port = parsePort(process.env.PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  const trustedOrigins = new Set([
    baseUrl,
    `http://localhost:${port}`,
    ...(process.env.TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  ]);
  return {
    host: "127.0.0.1",
    port,
    baseUrl,
    trustedOrigins,
    oauthRedirectUri: `${baseUrl}/oauth2/callback`,
    legacyCredentialsPath: findCredentialsPath(root),
    runtimeCredentialsPath: path.resolve(process.env.APP_CREDENTIALS_PATH ?? path.join(root, "local-data", "runtime-credentials.json")),
    databasePath: path.resolve(process.env.APP_DATABASE_PATH ?? path.join(root, "local-data", "gmail-opportunities.sqlite")),
    publicDir: path.join(root, "public"),
    openaiModel: process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini",
  };
}
