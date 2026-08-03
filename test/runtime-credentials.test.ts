import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { RuntimeCredentialStore } from "../src/infrastructure/runtime-credentials.js";

describe("RuntimeCredentialStore", () => {
  it("stores secrets with owner-only permissions and never clears omitted values", () => {
    const previous = {
      gmailClientId: process.env.GMAIL_CLIENT_ID,
      gmailClientSecret: process.env.GMAIL_CLIENT_SECRET,
      openaiApiKey: process.env.OPENAI_API_KEY,
    };
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.OPENAI_API_KEY;
    const directory = mkdtempSync(path.join(tmpdir(), "opportunity-desk-credentials-"));
    const filePath = path.join(directory, "runtime-credentials.json");
    const store = new RuntimeCredentialStore(filePath, null);
    try {
      assert.deepEqual(store.status(), { gmailConfigured: false, openaiConfigured: false, gmailClientId: null });
      store.update({
        gmailClientId: "client.apps.googleusercontent.com",
        gmailClientSecret: "gmail-secret",
        openaiApiKey: "openai-secret",
      });
      store.update({ gmailClientId: "client-2.apps.googleusercontent.com" });
      assert.deepEqual(store.read(), {
        gmailClientId: "client-2.apps.googleusercontent.com",
        gmailClientSecret: "gmail-secret",
        openaiApiKey: "openai-secret",
      });
      assert.equal(statSync(filePath).mode & 0o777, 0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      if (previous.gmailClientId === undefined) delete process.env.GMAIL_CLIENT_ID; else process.env.GMAIL_CLIENT_ID = previous.gmailClientId;
      if (previous.gmailClientSecret === undefined) delete process.env.GMAIL_CLIENT_SECRET; else process.env.GMAIL_CLIENT_SECRET = previous.gmailClientSecret;
      if (previous.openaiApiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous.openaiApiKey;
    }
  });
});
