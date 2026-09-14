const vscode = require("vscode");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { CLIENT_ID, REDIRECT_PORT, SCOPES, OAUTH_PROXY_BASE_URL } = require("./googleOAuthConfig");

const TOKENS_SECRET_KEY = "bloggerTools.oauthTokens";
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
// The actual code->token and refresh->token exchanges go through the
// oauth-proxy/ Worker rather than Google's token endpoint directly — it
// holds this OAuth client's secret so this extension never ships it (see
// googleOAuthConfig.js).
const PROXY_TOKEN_ENDPOINT = `${OAUTH_PROXY_BASE_URL}/token`;
const PROXY_REFRESH_ENDPOINT = `${OAUTH_PROXY_BASE_URL}/refresh`;

// Refresh this many ms before actual expiry, so a request never races a
// token that's valid when checked but expired by the time it reaches Google.
const EXPIRY_SAFETY_MARGIN_MS = 60 * 1000;

// Retry/backoff for quota and other transient errors (see isRetryableError).
// Doubling from 1s, capped at 30s/attempt, gives ~1+2+4+8+16 ≈ 31s of total
// waiting across 5 attempts before finally giving up — long enough to ride
// out a short-lived per-minute quota window without hanging indefinitely.
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30 * 1000;

let extensionContext;

/**
 * Stores the extension context so the rest of this module can reach
 * SecretStorage without every call site threading it through.
 * @param {vscode.ExtensionContext} context
 */
function init(context) {
  extensionContext = context;
}

/**
 * @returns {Promise<{ access_token: string, refresh_token: string, expiresAt: number } | null>}
 */
async function getStoredTokens() {
  const raw = await extensionContext.secrets.get(TOKENS_SECRET_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * @param {{ access_token: string, refresh_token: string, expiresAt: number }} tokens
 */
async function storeTokens(tokens) {
  await extensionContext.secrets.store(TOKENS_SECRET_KEY, JSON.stringify(tokens));
}

async function clearStoredTokens() {
  await extensionContext.secrets.delete(TOKENS_SECRET_KEY);
}

/**
 * True once a sign-in has stored a refresh token — used by the sidebar to
 * show a signed-in/signed-out status without making a network call.
 */
async function isSignedIn() {
  const tokens = await getStoredTokens();
  return !!(tokens && tokens.refresh_token);
}

/**
 * GET/PATCH/POST against an arbitrary HTTPS JSON endpoint with a bearer
 * token. Used for Blogger API calls (see bloggerApi.js).
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: object }} options
 * @returns {Promise<{ status: number, json: any }>}
 */
function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = https.request(
      {
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: options.method || "GET",
        headers: {
          ...(options.headers || {}),
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = {};
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a failed response is worth retrying rather than failing
 * immediately: HTTP 429 (rate limit), 5xx (transient server-side trouble),
 * or a 403 whose body names a quota-related reason — Google reports both
 * per-minute rate limits and daily quota exhaustion as 403s with a reason
 * like "rateLimitExceeded" or "userRateLimitExceeded", not as 429s.
 * @param {number} status
 * @param {any} json
 */
function isRetryableError(status, json) {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  if (status === 403) {
    const errors = (json && json.error && json.error.errors) || [];
    return errors.some((e) => /rateLimitExceeded|quotaExceeded/i.test(e.reason || ""));
  }
  return false;
}

/**
 * requestJson with exponential-backoff retry on quota/rate-limit and other
 * transient errors — used for every Blogger API call (see apiRequest) so
 * creating, editing, or even just reading posts survives a temporary quota
 * bump instead of failing the whole operation outright.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: object }} options
 * @param {(text: string) => void} [log]
 * @returns {Promise<{ status: number, json: any }>}
 */
async function requestJsonWithRetry(url, options, log) {
  let attempt = 0;
  for (;;) {
    const result = await requestJson(url, options);
    if (!isRetryableError(result.status, result.json) || attempt >= MAX_RETRIES) {
      return result;
    }
    const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
    attempt += 1;
    if (log) {
      log(
        `Blogger API returned HTTP ${result.status} (likely a quota/rate limit) — retrying in ` +
          `${Math.round(delay / 1000)}s (attempt ${attempt}/${MAX_RETRIES})…`,
      );
    }
    await sleep(delay);
  }
}

/**
 * Runs a one-time local HTTP server on REDIRECT_PORT to catch Google's
 * OAuth redirect (`?code=...`), since a VS Code extension has no other way
 * to receive a browser redirect. `promise` resolves with the authorization
 * code, or rejects if the user cancels (closes the tab without completing
 * consent) and nothing arrives within the timeout. `cancel()` lets a caller
 * tear the server down immediately instead of waiting out the full timeout
 * — needed when the browser never even opened (see signIn()), since
 * otherwise the port stays bound for up to 5 more minutes, and a
 * quickly-retried sign-in would fail with a confusing port-in-use error.
 * @returns {{ promise: Promise<string>, cancel: (message: string) => void }}
 */
function waitForAuthorizationCode() {
  let finish;
  const promise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        error
          ? "<p>Sign-in was cancelled or denied. You can close this tab and return to VS Code.</p>"
          : "<p>Signed in. You can close this tab and return to VS Code.</p>",
      );
      finish(error ? new Error(`Google sign-in failed: ${error}`) : null, code);
    });

    let settled = false;
    finish = (error, code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) {
        reject(error);
      } else {
        resolve(code);
      }
    };

    const timer = setTimeout(() => finish(new Error("Sign-in timed out — please try again."), null), 5 * 60 * 1000);

    server.on("error", (error) => finish(error, null));
    server.listen(REDIRECT_PORT, "127.0.0.1");
  });
  return { promise, cancel: (message) => finish(new Error(message), null) };
}

/**
 * Full interactive sign-in: opens Google's consent screen in the system
 * browser, catches the redirect locally, and exchanges the resulting code
 * for tokens. The author only ever sees Google's own consent screen — no
 * credential entry happens inside VS Code.
 * @param {(text: string) => void} [log]
 */
async function signIn(log) {
  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  const { promise: codePromise, cancel } = waitForAuthorizationCode();
  const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
  if (!opened) {
    cancel("Sign-in cancelled — the browser wasn't opened.");
    throw new Error('Sign-in cancelled — you declined to open the browser. Click "Sign In to Google" to try again.');
  }
  if (log) {
    log("Waiting for Google sign-in in your browser…");
  }
  const code = await codePromise;

  const tokenResult = await requestJson(PROXY_TOKEN_ENDPOINT, {
    method: "POST",
    body: { code, redirectUri: REDIRECT_URI },
  });
  if (tokenResult.status < 200 || tokenResult.status >= 300 || !tokenResult.json.access_token) {
    throw new Error(
      `Google sign-in failed: ${tokenResult.json.error_description || tokenResult.json.error || `HTTP ${tokenResult.status}`}`,
    );
  }

  await storeTokens({
    access_token: tokenResult.json.access_token,
    refresh_token: tokenResult.json.refresh_token,
    expiresAt: Date.now() + tokenResult.json.expires_in * 1000,
  });
  if (log) {
    log("Signed in to Google.");
  }
}

async function signOut() {
  await clearStoredTokens();
}

/**
 * Exchanges the stored refresh token for a new access token. Google does
 * not always return a new refresh_token on refresh — the existing one is
 * kept in that case, since it's still valid.
 * @param {{ access_token: string, refresh_token: string, expiresAt: number }} tokens
 */
async function refreshAccessToken(tokens) {
  const result = await requestJson(PROXY_REFRESH_ENDPOINT, {
    method: "POST",
    body: { refreshToken: tokens.refresh_token },
  });
  if (result.status < 200 || result.status >= 300 || !result.json.access_token) {
    return null;
  }
  const updated = {
    access_token: result.json.access_token,
    refresh_token: result.json.refresh_token || tokens.refresh_token,
    expiresAt: Date.now() + result.json.expires_in * 1000,
  };
  await storeTokens(updated);
  return updated;
}

/**
 * Returns a valid access token, signing in (if never authorized) or
 * refreshing (if the stored token is expired/near-expiry) as needed.
 * @param {(text: string) => void} [log]
 */
async function ensureAccessToken(log) {
  let tokens = await getStoredTokens();
  if (!tokens || !tokens.refresh_token) {
    await signIn(log);
    tokens = await getStoredTokens();
  } else if (tokens.expiresAt - EXPIRY_SAFETY_MARGIN_MS < Date.now()) {
    const refreshed = await refreshAccessToken(tokens);
    if (!refreshed) {
      await clearStoredTokens();
      await signIn(log);
      tokens = await getStoredTokens();
    } else {
      tokens = refreshed;
    }
  }
  return tokens.access_token;
}

/**
 * Calls one Google API JSON endpoint with the current access token,
 * transparently refreshing/re-authenticating once on a 401 before giving up.
 * @param {string} url - Full URL, e.g. "https://www.googleapis.com/blogger/v3/...".
 * @param {{ method?: string, body?: object }} [options]
 * @param {(text: string) => void} [log]
 */
async function apiRequest(url, options = {}, log) {
  const accessToken = await ensureAccessToken(log);
  let result = await requestJsonWithRetry(url, { ...options, headers: { Authorization: `Bearer ${accessToken}` } }, log);

  if (result.status === 401) {
    const tokens = await getStoredTokens();
    const refreshed = tokens ? await refreshAccessToken(tokens) : null;
    if (!refreshed) {
      throw new Error("Your Google sign-in has expired — please sign in again and retry.");
    }
    result = await requestJsonWithRetry(
      url,
      { ...options, headers: { Authorization: `Bearer ${refreshed.access_token}` } },
      log,
    );
  }

  if (result.status < 200 || result.status >= 300) {
    const message = (result.json && result.json.error && (result.json.error.message || result.json.error)) || `HTTP ${result.status}`;
    throw new Error(`Blogger API request failed: ${message}`);
  }

  return result.json;
}

module.exports = { init, signIn, signOut, isSignedIn, apiRequest };
