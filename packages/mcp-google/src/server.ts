#!/usr/bin/env node
import { google } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
const enabledApis = new Set((process.env.GOOGLE_ENABLED_APIS ?? "gmail,drive,calendar").split(","));

if (!clientId || !clientSecret || !refreshToken) {
  console.error("mcp-google: missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN");
  process.exit(1);
}

// googleapis' OAuth2Client refreshes the access token itself using the refresh
// token whenever a call gets a 401 — that's the whole point of passing client
// id/secret here instead of only a short-lived access token, so this server
// stays usable across a long-running MCP connection without Hertz having to
// manage token refresh externally.
const auth = new google.auth.OAuth2(clientId, clientSecret);
auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });

const gmail = google.gmail({ version: "v1", auth });
const drive = google.drive({ version: "v3", auth });
const calendar = google.calendar({ version: "v3", auth });

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function extractPlainText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text) return text;
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

function headerValue(headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

const server = new McpServer({ name: "kuclab-hertz-google", version: "0.1.0" });

if (enabledApis.has("gmail")) {
  server.registerTool(
    "gmail_search_messages",
    {
      description: "Search Gmail using the same query syntax as the Gmail search box (e.g. 'from:boss@company.com is:unread').",
      inputSchema: { query: z.string().describe("Gmail search query"), maxResults: z.number().int().positive().max(50).optional().default(10) },
    },
    async ({ query, maxResults }) => {
      const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults });
      const messages = res.data.messages ?? [];
      if (messages.length === 0) return { content: [{ type: "text", text: "No messages matched." }] };
      const details = await Promise.all(
        messages.map(async (m) => {
          const full = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
          const headers = full.data.payload?.headers;
          return `[${m.id}] ${headerValue(headers, "Date")} — ${headerValue(headers, "From")} — ${headerValue(headers, "Subject")}\n  ${full.data.snippet ?? ""}`;
        }),
      );
      return { content: [{ type: "text", text: details.join("\n\n") }] };
    },
  );

  server.registerTool(
    "gmail_get_message",
    { description: "Read one Gmail message's full body by id (see gmail_search_messages for ids).", inputSchema: { messageId: z.string() } },
    async ({ messageId }) => {
      const res = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
      const headers = res.data.payload?.headers;
      const body = extractPlainText(res.data.payload) || res.data.snippet || "(no readable body)";
      const text = `From: ${headerValue(headers, "From")}\nTo: ${headerValue(headers, "To")}\nSubject: ${headerValue(headers, "Subject")}\nDate: ${headerValue(headers, "Date")}\n\n${body}`;
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "gmail_send_message",
    {
      description: "Send an email from the connected Gmail account.",
      inputSchema: { to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional() },
    },
    async ({ to, subject, body, cc }) => {
      // Header values are interpolated raw into the RFC822 message — reject
      // CR/LF so a model (or injected input) can't smuggle extra headers in.
      for (const [field, value] of [["to", to], ["cc", cc], ["subject", subject]] as const) {
        if (value && /[\r\n]/.test(value)) {
          throw new Error(`gmail_send_message: "${field}" must not contain CR/LF characters`);
        }
      }
      const lines = [`To: ${to}`, cc ? `Cc: ${cc}` : undefined, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].filter(
        (l): l is string => l !== undefined,
      );
      const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
      const res = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
      return { content: [{ type: "text", text: `Sent (message id ${res.data.id}).` }] };
    },
  );
}

if (enabledApis.has("drive")) {
  server.registerTool(
    "drive_search_files",
    { description: "Search Google Drive by filename (substring match).", inputSchema: { query: z.string(), maxResults: z.number().int().positive().max(50).optional().default(20) } },
    async ({ query, maxResults }) => {
      const res = await drive.files.list({
        q: `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
        pageSize: maxResults,
        fields: "files(id, name, mimeType, modifiedTime)",
      });
      const files = res.data.files ?? [];
      const text = files.length === 0 ? "No files matched." : files.map((f) => `[${f.id}] ${f.name} (${f.mimeType}) — modified ${f.modifiedTime}`).join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "drive_get_file_content",
    { description: "Read a Drive file's text content by id (Google Docs are exported as plain text).", inputSchema: { fileId: z.string() } },
    async ({ fileId }) => {
      const meta = await drive.files.get({ fileId, fields: "mimeType, name" });
      const isGoogleNative = meta.data.mimeType?.startsWith("application/vnd.google-apps.");
      const res = isGoogleNative
        ? await drive.files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" })
        : await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
      return { content: [{ type: "text", text: String(res.data).slice(0, 100_000) }] };
    },
  );
}

if (enabledApis.has("calendar")) {
  server.registerTool(
    "calendar_list_calendars",
    { description: "List the Google calendars available to the connected account.", inputSchema: {} },
    async () => {
      const res = await calendar.calendarList.list();
      const items = res.data.items ?? [];
      const text =
        items.length === 0
          ? "No calendars found."
          : items.map((c) => `[${c.id}] ${c.summary}${c.primary ? " (primary)" : ""} — ${c.accessRole}`).join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "calendar_list_events",
    {
      description: "List upcoming events on a calendar.",
      inputSchema: {
        calendarId: z.string().optional().default("primary").describe("Calendar id (see calendar_list_calendars)"),
        timeMin: z.string().optional().describe("Start of the window, ISO 8601 (defaults to now)"),
        timeMax: z.string().optional().describe("End of the window, ISO 8601"),
        query: z.string().optional().describe("Free-text search in event titles/descriptions"),
        maxResults: z.number().int().positive().max(50).optional().default(10),
      },
    },
    async ({ calendarId, timeMin, timeMax, query, maxResults }) => {
      const res = await calendar.events.list({
        calendarId,
        timeMin: timeMin ?? new Date().toISOString(),
        timeMax,
        q: query,
        maxResults,
        singleEvents: true,
        orderBy: "startTime",
      });
      const items = res.data.items ?? [];
      if (items.length === 0) return { content: [{ type: "text", text: "No events found." }] };
      const text = items
        .map((e) => {
          const start = e.start?.dateTime ?? e.start?.date ?? "?";
          const end = e.end?.dateTime ?? e.end?.date ?? "?";
          return `[${e.id}] ${start} → ${end} — ${e.summary ?? "(no title)"}${e.location ? ` @ ${e.location}` : ""}`;
        })
        .join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "calendar_create_event",
    {
      description: "Create a calendar event.",
      inputSchema: {
        calendarId: z.string().optional().default("primary"),
        summary: z.string().describe("Event title"),
        start: z.string().describe("Start, ISO 8601 with timezone offset, e.g. 2026-09-22T10:00:00+02:00"),
        end: z.string().describe("End, ISO 8601 with timezone offset"),
        description: z.string().optional(),
        location: z.string().optional(),
      },
    },
    async ({ calendarId, summary, start, end, description, location }) => {
      const res = await calendar.events.insert({
        calendarId,
        requestBody: { summary, description, location, start: { dateTime: start }, end: { dateTime: end } },
      });
      return { content: [{ type: "text", text: `Created event "${res.data.summary}" (id ${res.data.id}). ${res.data.htmlLink ?? ""}` }] };
    },
  );

  server.registerTool(
    "calendar_delete_event",
    {
      description: "Delete a calendar event by id.",
      inputSchema: { calendarId: z.string().optional().default("primary"), eventId: z.string() },
    },
    async ({ calendarId, eventId }) => {
      await calendar.events.delete({ calendarId, eventId });
      return { content: [{ type: "text", text: `Deleted event ${eventId}.` }] };
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
