// OAuth client identity for a Google "Desktop app" installed-app flow. The
// client id is not confidential (it's already public in the browser-facing
// authorization URL every sign-in opens) so it's fine to hardcode here. The
// client *secret* is not shipped in this file, on purpose: even though
// Google doesn't treat a Desktop app's client_secret as truly confidential
// (see https://developers.google.com/identity/protocols/oauth2/native-app —
// there's no way to keep it secret in code that ships to end users'
// machines anyway), the VS Code Marketplace's automated secret scanner
// blocks any upload containing a credential-shaped string and can't tell
// the difference. The secret instead lives server-side, in the
// oauth-proxy/ Worker (see that folder's README/worker.js and this
// project's README.md "OAuth token-exchange proxy" section) — authClient.js
// calls that Worker instead of Google's token endpoint directly.
//
// See README.md "Google Cloud setup" for how to create the OAuth client
// itself in the Google Cloud Console (enable the Blogger API v3, configure
// the OAuth consent screen, create a Desktop app OAuth client).
const CLIENT_ID = "139107500820-i0ac217r23ev9ohle17311cdtlqkvfr1.apps.googleusercontent.com";

// Fixed loopback port for the local redirect listener (see authClient.js).
// Must be added as an authorized redirect URI (http://127.0.0.1:<port>/callback)
// on the OAuth client if the Google Cloud Console requires exact matches.
const REDIRECT_PORT = 42813;

const SCOPES = ["https://www.googleapis.com/auth/blogger"];

// Base URL of the deployed oauth-proxy/ Worker — replace with the URL
// `wrangler deploy` prints (or your own custom domain for it) once you've
// deployed that Worker and set its GOOGLE_CLIENT_SECRET secret.
const OAUTH_PROXY_BASE_URL = "https://availabooks-blogger-oauth-proxy.cotc.workers.dev";

module.exports = { CLIENT_ID, REDIRECT_PORT, SCOPES, OAUTH_PROXY_BASE_URL };
