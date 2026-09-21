import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type OAuthService = "google" | "slack" | "mistral" | "notion" | "github";

export interface OAuthStatePayload {
  service: OAuthService;
  catalogId: string;
  agentId: string | null;
  projectId: string | null;
  userId: string;
  nonce: string;
  /** PKCE verifier (Mistral flow) — carried inside the signed state. */
  codeVerifier?: string;
}

const GOOGLE_SCOPES: Record<string, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
  "google-drive": ["https://www.googleapis.com/auth/drive.readonly"],
  "google-calendar": ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"],
  "google-sheets": ["https://www.googleapis.com/auth/spreadsheets"],
  "google-docs": ["https://www.googleapis.com/auth/documents"],
};
// One-click "Připojit Google": a single consent screen covering Gmail, Kalendář,
// Disk, Tabulky i Dokumenty.
GOOGLE_SCOPES["google"] = [
  ...(GOOGLE_SCOPES["gmail"] ?? []),
  ...(GOOGLE_SCOPES["google-drive"] ?? []),
  ...(GOOGLE_SCOPES["google-calendar"] ?? []),
  ...(GOOGLE_SCOPES["google-sheets"] ?? []),
  ...(GOOGLE_SCOPES["google-docs"] ?? []),
];

const GITHUB_SCOPES = ["repo", "read:user"];

const SLACK_BOT_SCOPES = ["channels:history", "channels:read", "chat:write", "groups:read", "im:read", "mpim:read", "users:read"];

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Signs the OAuth `state` param with the app's own master key (already used
 * for at-rest secret encryption) instead of a server-side session store —
 * the callback can arrive on a different process/restart than the one that
 * issued it, and this way there's nothing to garbage-collect.
 */
export function signState(masterKey: Buffer, payload: OAuthStatePayload): string {
  const json = base64url(JSON.stringify(payload));
  const sig = base64url(createHmac("sha256", masterKey).update(json).digest());
  return `${json}.${sig}`;
}

export function verifyState(masterKey: Buffer, state: string): OAuthStatePayload | undefined {
  const [json, sig] = state.split(".");
  if (!json || !sig) return undefined;
  const expectedSig = base64url(createHmac("sha256", masterKey).update(json).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    return JSON.parse(Buffer.from(json, "base64url").toString("utf8")) as OAuthStatePayload;
  } catch {
    return undefined;
  }
}

export function googleScopesFor(catalogId: string): string[] {
  return GOOGLE_SCOPES[catalogId] ?? [];
}

export function googleAuthUrl(opts: { clientId: string; redirectUri: string; catalogId: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: googleScopesFor(opts.catalogId).join(" "),
    state: opts.state,
  });
  return `${googleAuthorizeUrl()}?${params.toString()}`;
}

/**
 * OAuth endpoint URLs are overridable via env so the whole connect flow can
 * be exercised end-to-end against a local mock provider in tests/QA.
 * Production defaults are the real provider URLs.
 */
export function googleAuthorizeUrl(): string {
  return process.env.HERTZ_OAUTH_GOOGLE_AUTHORIZE_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
}

export function googleTokenUrl(): string {
  return process.env.HERTZ_OAUTH_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
}

export function notionAuthorizeUrl(): string {
  return process.env.HERTZ_OAUTH_NOTION_AUTHORIZE_URL ?? "https://api.notion.com/v1/oauth/authorize";
}

export function notionTokenUrl(): string {
  return process.env.HERTZ_OAUTH_NOTION_TOKEN_URL ?? "https://api.notion.com/v1/oauth/token";
}

export function githubAuthorizeUrl(): string {
  return process.env.HERTZ_OAUTH_GITHUB_AUTHORIZE_URL ?? "https://github.com/login/oauth/authorize";
}

export function githubTokenUrl(): string {
  return process.env.HERTZ_OAUTH_GITHUB_TOKEN_URL ?? "https://github.com/login/oauth/access_token";
}

export async function exchangeGoogleCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const res = await fetch(googleTokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
  if (!body.refresh_token) {
    throw new Error("Google nevrátil refresh token — odeberte přístup aplikace na https://myaccount.google.com/permissions a připojte se znovu, aby se znovu zobrazil souhlas.");
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in, scope: body.scope };
}

export function slackAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: SLACK_BOT_SCOPES.join(","),
    state: opts.state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function exchangeSlackCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ botToken: string; teamId: string }> {
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
    }),
  });
  const body = (await res.json()) as { ok: boolean; error?: string; access_token?: string; team?: { id: string } };
  if (!res.ok || !body.ok || !body.access_token || !body.team) {
    throw new Error(`Slack token exchange failed: ${body.error ?? (await res.text().catch(() => res.statusText))}`);
  }
  return { botToken: body.access_token, teamId: body.team.id };
}

// --- Mistral (La Plateforme / Le Pro) — OAuth2 Authorization Code + PKCE -----

export const MISTRAL_AUTHORIZE_URL = "https://auth.mistral.ai/oauth/authorize";
export const MISTRAL_TOKEN_URL = "https://api.mistral.ai/oauth/token";
export const MISTRAL_SCOPES = ["openid", "profile", "email", "offline_access"];

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function mistralAuthUrl(opts: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: MISTRAL_SCOPES.join(" "),
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  });
  return `${MISTRAL_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeMistralCode(opts: {
  clientId: string;
  redirectUri: string;
  code: string;
  verifier: string;
}): Promise<{ accessToken: string; refreshToken?: string }> {
  const res = await fetch(MISTRAL_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: opts.clientId,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier,
    }),
  });
  if (!res.ok) throw new Error(`Mistral token exchange failed: ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; refresh_token?: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

export async function refreshMistralToken(opts: {
  clientId: string;
  refreshToken: string;
}): Promise<{ accessToken: string; refreshToken?: string }> {
  const res = await fetch(MISTRAL_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: opts.clientId,
      refresh_token: opts.refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`Mistral refresh failed: ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; refresh_token?: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

// --- Notion (public integration, OAuth2 Authorization Code) -----------------
// Notion access tokens don't expire, so no refresh flow is needed — the token
// is stored encrypted alongside the MCP server row and used until disconnect.

export function notionAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    owner: "user",
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `${notionAuthorizeUrl()}?${params.toString()}`;
}

export async function exchangeNotionCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ accessToken: string; workspaceName: string; workspaceId: string; botId: string }> {
  const credentials = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
  const res = await fetch(notionTokenUrl(), {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code: opts.code, redirect_uri: opts.redirectUri }),
  });
  if (!res.ok) throw new Error(`Notion token exchange failed: ${await res.text()}`);
  const body = (await res.json()) as {
    access_token?: string;
    workspace_name?: string;
    workspace_id?: string;
    bot_id?: string;
  };
  if (!body.access_token) throw new Error("Notion nevrátilo přístupový token — zkuste připojení zopakovat.");
  return {
    accessToken: body.access_token,
    workspaceName: body.workspace_name ?? "",
    workspaceId: body.workspace_id ?? "",
    botId: body.bot_id ?? "",
  };
}

// --- GitHub (OAuth App, Authorization Code) ----------------------------------
// Classic GitHub OAuth App tokens don't expire; the token is stored encrypted
// alongside the MCP server row and used until disconnect.

export function githubAuthUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: GITHUB_SCOPES.join(" "),
    state: opts.state,
  });
  return `${githubAuthorizeUrl()}?${params.toString()}`;
}

export async function exchangeGithubCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ accessToken: string; scope: string }> {
  const res = await fetch(githubTokenUrl(), {
    method: "POST",
    headers: { Accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed: ${await res.text()}`);
  const body = (await res.json()) as { access_token?: string; scope?: string; error_description?: string };
  if (!body.access_token) {
    throw new Error(`GitHub nevrátil přístupový token — ${body.error_description ?? "zkuste připojení zopakovat."}`);
  }
  return { accessToken: body.access_token, scope: body.scope ?? "" };
}
