/**
 * Token-exchange proxy for the AvailaBooks Blog Tools VS Code extension's
 * Google sign-in. Holds the OAuth client's secret server-side so it never
 * ships inside the published .vsix — the VS Code Marketplace's automated
 * secret scanner blocks any upload containing a credential-shaped string,
 * and a Desktop-app OAuth client's secret (while not meant to be
 * *confidential* per Google's own docs) is still recognizable to that
 * scanner as one. See ../README.md.
 *
 * The extension (see ../authClient.js) still opens Google's own consent
 * screen directly in the author's system browser and still catches the
 * redirect itself — this Worker only ever sees an already-issued
 * authorization code or refresh token, exchanging it for tokens with Google
 * on the extension's behalf.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JSON_HEADERS = { "content-type": "application/json" };

/**
 * @param {unknown} body
 * @param {number} [status]
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * POSTs a token-endpoint form to Google and relays its JSON response
 * verbatim (success or error) under the same HTTP status, so the
 * extension's existing handling — which already expects Google's own
 * token-endpoint response shape — keeps working unchanged.
 * @param {Record<string, string>} form
 */
async function exchangeWithGoogle(form) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const text = await response.text();
  return new Response(text, { status: response.status, headers: JSON_HEADERS });
}

export default {
  /**
   * @param {Request} request
   * @param {{ GOOGLE_CLIENT_ID: string, GOOGLE_CLIENT_SECRET: string }} env
   */
  async fetch(request, env) {
    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }

    const { pathname } = new URL(request.url);
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid_json_body" }, 400);
    }

    if (pathname === "/token") {
      if (!body.code || !body.redirectUri) {
        return jsonResponse({ error: "missing_code_or_redirect_uri" }, 400);
      }
      return exchangeWithGoogle({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code: body.code,
        grant_type: "authorization_code",
        redirect_uri: body.redirectUri,
      });
    }

    if (pathname === "/refresh") {
      if (!body.refreshToken) {
        return jsonResponse({ error: "missing_refresh_token" }, 400);
      }
      return exchangeWithGoogle({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: body.refreshToken,
        grant_type: "refresh_token",
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  },
};
