#!/usr/bin/env node
import { google } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
const enabledApis = new Set((process.env.GOOGLE_ENABLED_APIS ?? "gmail,drive,calendar,sheets,docs,slides").split(","));

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
// GOOGLE_API_ROOT_URL = testovací/mock přepínač: když je nastavený (např.
// http://127.0.0.1:8080/), míří všechna volání Google API na něj místo
// produkčních endpointů. V produkci se nenastavuje.
const apiRootUrl = process.env.GOOGLE_API_ROOT_URL || undefined;
const sheets = google.sheets({ version: "v4", auth, ...(apiRootUrl ? { rootUrl: apiRootUrl } : {}) });
const docs = google.docs({ version: "v1", auth, ...(apiRootUrl ? { rootUrl: apiRootUrl } : {}) });
const slides = google.slides({ version: "v1", auth, ...(apiRootUrl ? { rootUrl: apiRootUrl } : {}) });

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

if (enabledApis.has("sheets")) {
  server.registerTool(
    "sheets_read_range",
    {
      description: "Read a range of cells from a Google Sheet (A1 notation, e.g. 'List1!A1:C10'). Returns the values as rows.",
      inputSchema: {
        spreadsheetId: z.string().describe("Spreadsheet id (from the URL between /d/ and /edit)"),
        range: z.string().describe("A1 range, e.g. 'List1!A1:C10'"),
      },
    },
    async ({ spreadsheetId, range }) => {
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      const values = res.data.values ?? [];
      if (values.length === 0) return { content: [{ type: "text", text: "Range is empty." }] };
      const text = values.map((row) => row.map((c) => String(c ?? "")).join("\t")).join("\n");
      return { content: [{ type: "text", text: `Range ${res.data.range} (${values.length} rows):\n${text}` }] };
    },
  );

  server.registerTool(
    "sheets_write_range",
    {
      description:
        "Overwrite a range of cells in a Google Sheet (A1 notation). Replaces existing content in that range — a destructive write, always asks the user for approval first.",
      inputSchema: {
        spreadsheetId: z.string(),
        range: z.string().describe("A1 range where the top-left value lands, e.g. 'List1!A1'"),
        values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).describe("Rows of values to write"),
      },
    },
    async ({ spreadsheetId, range, values }) => {
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
      });
      return { content: [{ type: "text", text: `Wrote ${res.data.updatedCells ?? 0} cells to ${res.data.updatedRange}.` }] };
    },
  );

  server.registerTool(
    "sheets_append_values",
    {
      description: "Append rows to the end of a Google Sheet table (A1 notation, e.g. 'List1!A:C'). Does not overwrite existing data.",
      inputSchema: {
        spreadsheetId: z.string(),
        range: z.string().describe("A1 range of the table columns, e.g. 'List1!A:C'"),
        values: z.array(z.array(z.union([z.string(), z.number(), z.boolean()]))).describe("Rows to append"),
      },
    },
    async ({ spreadsheetId, range, values }) => {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values },
      });
      return { content: [{ type: "text", text: `Appended ${res.data.updates?.updatedRows ?? values.length} rows to ${res.data.updates?.updatedRange}.` }] };
    },
  );

  server.registerTool(
    "sheets_create_spreadsheet",
    {
      description: "Create a new empty Google spreadsheet with the given title (optionally with named sheets).",
      inputSchema: {
        title: z.string().describe("Spreadsheet title"),
        sheetTitles: z.array(z.string()).optional().describe("Names of the initial sheets (default: one sheet)"),
      },
    },
    async ({ title, sheetTitles }) => {
      const res = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title },
          sheets: sheetTitles?.map((t) => ({ properties: { title: t } })),
        },
      });
      return { content: [{ type: "text", text: `Created spreadsheet "${res.data.properties?.title}" (id ${res.data.spreadsheetId}). ${res.data.spreadsheetUrl ?? ""}` }] };
    },
  );
}

function extractDocsText(structural: any[] | undefined): string {
  if (!structural) return "";
  let out = "";
  for (const el of structural) {
    if (el.paragraph?.elements) {
      for (const pe of el.paragraph.elements) {
        if (pe.textRun?.content) out += pe.textRun.content;
      }
    } else if (el.table?.tableRows) {
      for (const row of el.table.tableRows) {
        const cells = (row.tableCells ?? []).map((cell: any) => extractDocsText(cell.content).replace(/\n+$/, ""));
        out += cells.join(" | ") + "\n";
      }
    } else if (el.sectionBreak) {
      out += "\n";
    }
  }
  return out;
}

if (enabledApis.has("docs")) {
  server.registerTool(
    "docs_read",
    {
      description: "Read a Google document's full text by id (from the URL between /d/ and /edit).",
      inputSchema: {
        documentId: z.string(),
        maxChars: z.number().int().positive().max(200_000).optional().default(100_000),
      },
    },
    async ({ documentId, maxChars }) => {
      const res = await docs.documents.get({ documentId });
      const text = extractDocsText(res.data.body?.content).slice(0, maxChars);
      const title = res.data.title ?? "(no title)";
      return { content: [{ type: "text", text: `Document: ${title}\n\n${text || "(empty document)"}` }] };
    },
  );

  server.registerTool(
    "docs_create_document",
    {
      description: "Create a new empty Google document with the given title.",
      inputSchema: { title: z.string().describe("Document title") },
    },
    async ({ title }) => {
      const res = await docs.documents.create({ requestBody: { title } });
      return { content: [{ type: "text", text: `Created document "${res.data.title}" (id ${res.data.documentId}).` }] };
    },
  );

  server.registerTool(
    "docs_append_text",
    {
      description: "Append text to the end of a Google document. Adds to existing content, never overwrites.",
      inputSchema: {
        documentId: z.string(),
        text: z.string().max(100_000).describe("Text to append (a trailing newline is added if missing)"),
      },
    },
    async ({ documentId, text }) => {
      const doc = await docs.documents.get({ documentId, fields: "body(content(endIndex))" });
      const content = doc.data.body?.content ?? [];
      const endIndex = content.length > 0 ? (content[content.length - 1]?.endIndex ?? 2) : 2;
      const body = text.endsWith("\n") ? text : `${text}\n`;
      await docs.documents.batchUpdate({
        documentId,
        requestBody: { requests: [{ insertText: { location: { index: Math.max(endIndex - 1, 1) }, text: body } }] },
      });
      return { content: [{ type: "text", text: `Appended ${body.length} characters to the document.` }] };
    },
  );
}

/** Vytáhne prostý text ze všech textových prvků slidu. */
function extractSlideText(pageElements: any[] | undefined): string {
  if (!pageElements) return "";
  let out = "";
  for (const el of pageElements) {
    for (const te of el.shape?.text?.textElements ?? []) {
      if (te.textRun?.content) out += te.textRun.content;
    }
    for (const cell of el.table?.tableRows?.flatMap((r: any) => r.tableCells ?? []) ?? []) {
      out += extractSlideText(cell.text?.textElements ? [{ shape: { text: cell.text } }] : []);
    }
  }
  return out.trim();
}

if (enabledApis.has("slides")) {
  server.registerTool(
    "slides_create_presentation",
    {
      description: "Create a new empty Google Slides presentation with the given title.",
      inputSchema: { title: z.string().describe("Presentation title") },
    },
    async ({ title }) => {
      const res = await slides.presentations.create({ requestBody: { title } });
      return { content: [{ type: "text", text: `Created presentation "${res.data.title}" (id ${res.data.presentationId}).` }] };
    },
  );

  server.registerTool(
    "slides_get_presentation",
    {
      description: "Read a Google Slides presentation: slide count and the text content of every slide.",
      inputSchema: {
        presentationId: z.string().describe("Presentation id (from the URL between /d/ and /edit)"),
        maxChars: z.number().int().positive().max(200_000).optional().default(50_000),
      },
    },
    async ({ presentationId, maxChars }) => {
      const res = await slides.presentations.get({ presentationId });
      const all = res.data.slides ?? [];
      const parts = all.map((s: any, i: number) => `--- Slide ${i + 1} ---\n${extractSlideText(s.pageElements) || "(empty slide)"}`);
      return { content: [{ type: "text", text: `Presentation: ${res.data.title ?? "(no title)"} (${all.length} slides)\n\n${parts.join("\n\n")}`.slice(0, maxChars) }] };
    },
  );

  server.registerTool(
    "slides_add_slide",
    {
      description: "Append a new slide with a title and body text to a Google Slides presentation (TITLE_AND_BODY layout).",
      inputSchema: {
        presentationId: z.string(),
        title: z.string().max(500).optional().describe("Slide title (heading)"),
        body: z.string().max(50_000).optional().describe("Slide body text"),
      },
    },
    async ({ presentationId, title, body }) => {
      const created = await slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: [{ createSlide: { slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" } } }] },
      });
      const slideId = (created.data.replies?.[0] as any)?.createSlide?.objectId;
      if (!slideId) throw new Error("Google did not return the new slide's id.");
      const got = await slides.presentations.get({ presentationId, fields: "slides(objectId,pageElements(objectId,shape(placeholder)))" });
      const slide = (got.data.slides ?? []).find((s: any) => s.objectId === slideId);
      const requests: any[] = [];
      for (const el of slide?.pageElements ?? []) {
        const kind = el.shape?.placeholder?.type;
        if (kind === "TITLE" && title) requests.push({ insertText: { objectId: el.objectId, text: title } });
        if (kind === "BODY" && body) requests.push({ insertText: { objectId: el.objectId, text: body } });
      }
      if (requests.length > 0) {
        await slides.presentations.batchUpdate({ presentationId, requestBody: { requests } });
      }
      return { content: [{ type: "text", text: `Added slide (id ${slideId})${requests.length > 0 ? " with text." : " — placeholder shapes not found, slide left blank."}` }] };
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
