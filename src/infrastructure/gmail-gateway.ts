import type { OAuth2Client } from "google-auth-library";
import { google, gmail_v1 } from "googleapis";
import type { GmailGateway, GmailProfile } from "../application/ports.js";
import type { StoredEmail } from "../domain/models.js";

function headerValue(headers: readonly gmail_v1.Schema$MessagePartHeader[], name: string): string {
  return headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value?.trim() ?? "";
}

function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/li>|<\/tr>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function normalizeBody(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 50_000);
}

function collectBodies(part: gmail_v1.Schema$MessagePart | undefined): { plain: string[]; html: string[] } {
  const result = { plain: [] as string[], html: [] as string[] };
  if (!part) return result;

  const visit = (current: gmail_v1.Schema$MessagePart): void => {
    const mimeType = current.mimeType?.toLowerCase() ?? "";
    const decoded = decodeBase64Url(current.body?.data);
    if (decoded && mimeType === "text/plain") result.plain.push(decoded);
    if (decoded && mimeType === "text/html") result.html.push(htmlToText(decoded));
    for (const child of current.parts ?? []) visit(child);
  };
  visit(part);
  return result;
}

function parseMailbox(value: string): { name: string | null; email: string | null } {
  const angleMatch = value.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  if (angleMatch) {
    return {
      name: angleMatch[1]?.trim() || null,
      email: angleMatch[2]?.trim().toLowerCase() || null,
    };
  }
  const email = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() ?? null;
  return { name: email && value.trim() === email ? null : value.trim() || null, email };
}

function parseRecipientEmails(value: string): string[] {
  return Array.from(value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi), (match) => match[0].toLowerCase());
}

function parseMessageReferences(value: string): string[] {
  return Array.from(value.matchAll(/<[^>]+>/g), (match) => match[0]);
}

export class GoogleGmailGateway implements GmailGateway {
  private readonly gmail: gmail_v1.Gmail;

  constructor(auth: OAuth2Client) {
    this.gmail = google.gmail({ version: "v1", auth });
  }

  async getProfile(): Promise<GmailProfile> {
    const response = await this.gmail.users.getProfile({ userId: "me" });
    if (!response.data.emailAddress || !response.data.historyId) {
      throw new Error("Gmail profile did not return an email address and history ID.");
    }
    return { emailAddress: response.data.emailAddress, historyId: response.data.historyId };
  }

  async listMessageIds(label: "INBOX" | "SENT", limit: number): Promise<readonly string[]> {
    const response = await this.gmail.users.messages.list({
      userId: "me",
      labelIds: [label],
      maxResults: limit,
      includeSpamTrash: false,
    });
    return (response.data.messages ?? []).flatMap((message) => (message.id ? [message.id] : []));
  }

  async listAddedMessageIds(startHistoryId: string): Promise<{ ids: readonly string[]; latestHistoryId: string }> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latestHistoryId = startHistoryId;
    do {
      const response = await this.gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        maxResults: 500,
        pageToken,
      });
      for (const history of response.data.history ?? []) {
        for (const added of history.messagesAdded ?? []) {
          if (added.message?.id) ids.add(added.message.id);
        }
      }
      latestHistoryId = response.data.historyId ?? latestHistoryId;
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return { ids: [...ids], latestHistoryId };
  }

  async getMessage(id: string): Promise<StoredEmail> {
    const response = await this.gmail.users.messages.get({ userId: "me", id, format: "full" });
    const message = response.data;
    if (!message.id || !message.threadId || !message.internalDate) {
      throw new Error(`Gmail message ${id} is missing required metadata.`);
    }
    const headers = message.payload?.headers ?? [];
    const from = parseMailbox(headerValue(headers, "From"));
    const labelIds = message.labelIds ?? [];
    const bodies = collectBodies(message.payload);
    const bodyText = normalizeBody(bodies.plain.join("\n\n") || bodies.html.join("\n\n") || message.snippet || "");

    return {
      gmailMessageId: message.id,
      threadId: message.threadId,
      historyId: message.historyId ?? null,
      internalDateMs: Number(message.internalDate),
      direction: labelIds.includes("SENT") ? "outbound" : "inbound",
      labelIds,
      subject: headerValue(headers, "Subject") || "(no subject)",
      fromName: from.name,
      fromEmail: from.email,
      to: parseRecipientEmails(headerValue(headers, "To")),
      cc: parseRecipientEmails(headerValue(headers, "Cc")),
      replyTo: headerValue(headers, "Reply-To") || null,
      messageIdHeader: headerValue(headers, "Message-ID") || null,
      inReplyTo: headerValue(headers, "In-Reply-To") || null,
      references: parseMessageReferences(headerValue(headers, "References")),
      listUnsubscribe: headerValue(headers, "List-Unsubscribe") || null,
      snippet: message.snippet ?? "",
      bodyText,
      fetchedAt: new Date().toISOString(),
    };
  }
}
