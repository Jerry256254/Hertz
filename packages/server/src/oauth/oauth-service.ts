import { createHmac, timingSafeEqual } from "node:crypto";

export type OAuthService = "google" | "slack";

export interface OAuthStatePayload {
  service: OAuthService;
  catalogId: string;
  agentId: string | null;
  projectId: string | null;
  userId: string;
  nonce: string;
}

const GOOGLE_SCOPES: Record<string, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
  "google-drive": ["https://www.googleapis.com/auth/drive.readonly"],
};

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
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
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
    throw new Error("Google didn't return a refresh token — revoke this app's access at https://myaccount.google.com/permissions and try connecting again so it re-prompts for consent.");
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
