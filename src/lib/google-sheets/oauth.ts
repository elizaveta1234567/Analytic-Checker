import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const googleSheetsScope = "https://www.googleapis.com/auth/spreadsheets";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const authEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
const googleOAuthRedirectUri =
  "http://localhost:3000/api/google/oauth/callback";
const tokenRefreshSkewMs = 60000;
const tokenRefreshTimeoutMs = 25000;
const tokenRefreshNetworkRetryDelaysMs = [1000, 2000, 5000];
const tokenRefreshMaxNetworkAttempts = 3;
const retryableTokenNetworkCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ABORT_ERR",
]);

type GoogleOAuthState = {
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
};

type StoredGoogleTokens = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export class GoogleOAuthNetworkError extends Error {
  technicalDetail?: string;

  constructor(message: string, technicalDetail?: string) {
    super(message);
    this.name = "GoogleOAuthNetworkError";
    this.technicalDetail = technicalDetail;
  }
}

export class GoogleOAuthReconnectRequiredError extends Error {
  constructor(message = "Google connection expired. Connect Google again.") {
    super(message);
    this.name = "GoogleOAuthReconnectRequiredError";
  }
}

export class GoogleOAuthMisconfiguredError extends Error {
  constructor(
    message = "Google OAuth is misconfigured. Check GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.",
  ) {
    super(message);
    this.name = "GoogleOAuthMisconfiguredError";
  }
}

const globalAny = globalThis as typeof globalThis & {
  __googleOAuthStates?: Map<string, GoogleOAuthState>;
};

function oauthStates(): Map<string, GoogleOAuthState> {
  if (!globalAny.__googleOAuthStates) {
    globalAny.__googleOAuthStates = new Map();
  }
  return globalAny.__googleOAuthStates;
}

export function getGoogleOAuthClientId(): string | null {
  const clientId =
    process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() ||
    process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID?.trim() ||
    "";
  return clientId || null;
}

export function getGoogleOAuthClientSecret(): string | null {
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || "";
  return clientSecret || null;
}

export function logGoogleOAuthConfig(): void {
  console.log(
    `[googleOAuth] clientId configured=${getGoogleOAuthClientId() !== null}`,
  );
  console.log(
    `[googleOAuth] clientSecret configured=${
      getGoogleOAuthClientSecret() !== null
    }`,
  );
  console.log(`[googleOAuth] cwd=${process.cwd()}`);
}

function requireGoogleOAuthClientSecret(): string {
  const clientSecret = getGoogleOAuthClientSecret();
  if (!clientSecret) {
    throw new Error(
      "Google OAuth client secret is not configured. Set GOOGLE_OAUTH_CLIENT_SECRET.",
    );
  }
  return clientSecret;
}

function tokenStorePath(): string {
  const base =
    process.env.APPDATA ||
    process.env.LOCALAPPDATA ||
    path.join(homedir(), ".config");
  return path.join(base, "Analytics Checker", "google-oauth-tokens.json");
}

function readStoredTokens(): StoredGoogleTokens | null {
  const filePath = tokenStorePath();
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<
      StoredGoogleTokens
    >;
    const accessToken =
      typeof parsed.accessToken === "string" ? parsed.accessToken : undefined;
    const refreshToken =
      typeof parsed.refreshToken === "string"
        ? parsed.refreshToken
        : undefined;
    const expiresAt =
      typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined;

    if (!accessToken && !refreshToken) {
      return null;
    }

    return {
      accessToken,
      refreshToken,
      expiresAt,
    };
  } catch (e) {
    console.error("[google-auth] failed to read token file", e);
    return null;
  }
}

function writeStoredTokens(tokens: StoredGoogleTokens): void {
  const filePath = tokenStorePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(tokens, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function clearStoredGoogleTokens(): void {
  const filePath = tokenStorePath();
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

function randomUrlToken(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function getGoogleOAuthRedirectUri(): string {
  return googleOAuthRedirectUri;
}

export function createGoogleAuthUrl(): string {
  const clientId = getGoogleOAuthClientId();
  if (!clientId) {
    throw new Error(
      "Google OAuth client id is not configured. Set GOOGLE_OAUTH_CLIENT_ID.",
    );
  }
  requireGoogleOAuthClientSecret();

  const state = randomUrlToken();
  const codeVerifier = randomUrlToken();
  const redirectUri = getGoogleOAuthRedirectUri();
  console.log(`[googleOAuth] redirect_uri=${redirectUri}`);
  oauthStates().set(state, {
    codeVerifier,
    redirectUri,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: googleSheetsScope,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: pkceChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
  });

  return `${authEndpoint}?${params.toString()}`;
}

async function readTokenResponse(response: Response): Promise<TokenResponse> {
  const text = await response.text();
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    return { error: "invalid_response", error_description: text };
  }
}

function tokenErrorMessage(payload: TokenResponse, fallback: string): string {
  const message = payload.error_description || payload.error || fallback;
  if (/client_secret/i.test(message)) {
    return `${message}. Expected env variable GOOGLE_OAUTH_CLIENT_SECRET.`;
  }
  return message;
}

function getObjectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function stringifyDetail(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number") {
    return String(value);
  }
  return null;
}

function getNetworkDetail(error: unknown): string {
  const cause = getObjectProperty(error, "cause");
  return (
    stringifyDetail(getObjectProperty(cause, "code")) ??
    stringifyDetail(getObjectProperty(cause, "message")) ??
    stringifyDetail(getObjectProperty(error, "message")) ??
    String(error)
  );
}

function isRetryableTokenNetworkError(error: unknown): boolean {
  const cause = getObjectProperty(error, "cause");
  const causeCode = stringifyDetail(getObjectProperty(cause, "code"));
  const name = stringifyDetail(getObjectProperty(error, "name"));
  const message = stringifyDetail(getObjectProperty(error, "message"));
  const causeMessage = stringifyDetail(getObjectProperty(cause, "message"));

  return (
    (causeCode !== null && retryableTokenNetworkCodes.has(causeCode)) ||
    name === "AbortError" ||
    name === "TimeoutError" ||
    message === "fetch failed" ||
    /timed out|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(
      `${message ?? ""} ${causeMessage ?? ""}`,
    )
  );
}

function getSafeErrorName(error: unknown): string {
  return stringifyDetail(getObjectProperty(error, "name")) ?? "Error";
}

function getSafeErrorMessage(error: unknown): string {
  return stringifyDetail(getObjectProperty(error, "message")) ?? String(error);
}

function getSafeCauseCode(error: unknown): string | null {
  const cause = getObjectProperty(error, "cause");
  return stringifyDetail(getObjectProperty(cause, "code"));
}

function isTokenRefreshTimeoutError(error: unknown): boolean {
  const name = getSafeErrorName(error);
  const message = getSafeErrorMessage(error);
  const causeCode = getSafeCauseCode(error);
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    causeCode === "ABORT_ERR" ||
    /timed out|timeout/i.test(message)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTokenRefreshResponse(
  body: URLSearchParams,
): Promise<Response> {
  let lastNetworkError: unknown = null;
  for (let attempt = 1; attempt <= tokenRefreshMaxNetworkAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      tokenRefreshTimeoutMs,
    );
    console.log("[googleOAuth] refresh start");
    console.log(`[googleOAuth] refresh timeoutMs=${tokenRefreshTimeoutMs}`);
    try {
      const response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      console.log(`[googleOAuth] refresh response.status=${response.status}`);
      return response;
    } catch (error) {
      lastNetworkError = error;
      console.warn(
        `[googleOAuth] refresh failed name=${getSafeErrorName(
          error,
        )} message=${getSafeErrorMessage(error)} causeCode=${
          getSafeCauseCode(error) ?? "null"
        }`,
      );
      if (isTokenRefreshTimeoutError(error)) {
        throw new GoogleOAuthNetworkError(
          "Google OAuth is taking too long to respond. Try reconnecting Google.",
          getNetworkDetail(error),
        );
      }
      if (
        !isRetryableTokenNetworkError(error) ||
        attempt >= tokenRefreshMaxNetworkAttempts
      ) {
        throw new GoogleOAuthNetworkError(
          "Google token refresh network error",
          getNetworkDetail(error),
        );
      }

      await sleep(tokenRefreshNetworkRetryDelaysMs[attempt - 1] ?? 5000);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new GoogleOAuthNetworkError(
    "Google token refresh network error",
    getNetworkDetail(lastNetworkError),
  );
}

export async function exchangeGoogleOAuthCode(
  code: string,
  state: string,
): Promise<void> {
  logGoogleOAuthConfig();
  const clientId = getGoogleOAuthClientId();
  if (!clientId) {
    throw new GoogleOAuthMisconfiguredError();
  }
  let clientSecret = "";
  try {
    clientSecret = requireGoogleOAuthClientSecret();
  } catch {
    throw new GoogleOAuthMisconfiguredError();
  }

  const stateRecord = oauthStates().get(state);
  oauthStates().delete(state);
  if (!stateRecord) {
    throw new Error("Google auth state expired. Try connecting again.");
  }

  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: stateRecord.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: stateRecord.redirectUri,
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams,
  });
  const payload = await readTokenResponse(response);
  if (!response.ok || !payload.access_token) {
    throw new Error(
      tokenErrorMessage(
        payload,
        `Google token exchange failed: HTTP ${response.status}`,
      ),
    );
  }

  writeStoredTokens({
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  });
}

async function refreshGoogleAccessToken(
  tokens: StoredGoogleTokens,
): Promise<StoredGoogleTokens> {
  logGoogleOAuthConfig();
  const clientId = getGoogleOAuthClientId();
  if (!clientId) {
    throw new GoogleOAuthMisconfiguredError();
  }
  let clientSecret = "";
  try {
    clientSecret = requireGoogleOAuthClientSecret();
  } catch {
    throw new GoogleOAuthMisconfiguredError();
  }
  if (!tokens.refreshToken) {
    throw new Error("Google auth required");
  }

  console.log("[googleOAuth] refresh request fields", {
    clientIdExists: Boolean(clientId),
    clientSecretExists: Boolean(clientSecret),
    refreshTokenExists: Boolean(tokens.refreshToken),
    grantType: "refresh_token",
  });

  const response = await fetchTokenRefreshResponse(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
    }),
  );
  const payload = await readTokenResponse(response);
  if (!response.ok || !payload.access_token) {
    const errorCode = payload.error ?? "";
    const errorMessage = tokenErrorMessage(
      payload,
      `Google token refresh failed: HTTP ${response.status}`,
    );
    console.warn(
      `[googleOAuth] refresh failed name=GoogleTokenRefreshError message=${errorMessage} causeCode=${
        errorCode || "null"
      }`,
    );
    if (errorCode === "invalid_grant") {
      clearStoredGoogleTokens();
      throw new GoogleOAuthReconnectRequiredError();
    }
    if (errorCode === "invalid_client") {
      throw new GoogleOAuthMisconfiguredError();
    }
    throw new Error(errorMessage);
  }
  console.log(
    `[googleOAuth] refresh success accessTokenExists=${Boolean(
      payload.access_token,
    )}`,
  );

  const nextTokens = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
  writeStoredTokens(nextTokens);
  return nextTokens;
}

export async function getGoogleSheetsAccessToken(): Promise<string> {
  const tokens = readStoredTokens();
  if (!tokens) {
    throw new Error("Google access token is missing. Reconnect Google.");
  }

  if (
    tokens.accessToken &&
    typeof tokens.expiresAt === "number" &&
    tokens.expiresAt > Date.now() + tokenRefreshSkewMs
  ) {
    return tokens.accessToken;
  }

  if (tokens.refreshToken) {
    return (await refreshGoogleAccessToken(tokens)).accessToken ?? "";
  }

  throw new Error("Google access token is missing. Reconnect Google.");
}

export async function refreshGoogleSheetsAccessToken(): Promise<string> {
  const tokens = readStoredTokens();
  if (!tokens?.refreshToken) {
    throw new Error("Google access token is missing. Reconnect Google.");
  }

  return (await refreshGoogleAccessToken(tokens)).accessToken ?? "";
}

export function getGoogleAuthStatus() {
  const tokens = readStoredTokens();
  const accessToken =
    typeof tokens?.accessToken === "string" ? tokens.accessToken : "";
  const refreshToken =
    typeof tokens?.refreshToken === "string" ? tokens.refreshToken : "";
  return {
    configured:
      getGoogleOAuthClientId() !== null &&
      getGoogleOAuthClientSecret() !== null,
    connected: accessToken.length > 0 || refreshToken.length > 0,
    accessTokenExists: accessToken.length > 0,
    accessTokenLength: accessToken.length,
    refreshTokenExists: refreshToken.length > 0,
  };
}
