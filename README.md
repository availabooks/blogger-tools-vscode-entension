# AvailaBooks Blog Tools (VS Code / Cursor)

Mirrors a Blogger-hosted Availabooks textbook's posts to local `.html` files
so an author (with an AI assistant) can edit chapters as plain files, then
syncs changes back and forth with Blogger — for the free, Blogger-template
flavor of Availabooks that doesn't integrate with an LMS. Complements
`tools/author-tools`, which does the equivalent job for the LMS-integrated
book pipeline.

## What it does

- **Imports** every post from a Blogger blog into `books/<blog name>/` as
  local `.html` files, tracked in a `blog.yaml` manifest.
- **Syncs** local edits and Blogger edits both ways, using a three-way
  content-hash comparison so it only touches what actually changed, and
  pauses to ask when the same post changed on both sides.
- **Consolidates** posts that were published under different months (so
  their permalinks don't line up) back under one shared month, and rewrites
  cross-chapter links to plain local file names in the process.
- **Previews** the book locally as fully-rendered pages (post content +
  the blog's real template/chrome), served with the Live Server extension.
- Handles **Google sign-in** itself, via a standard OAuth2 "installed app"
  flow — the author only ever sees Google's own consent screen.

## Requirements

- VS Code (or Cursor) 1.80+.
- A book folder open in the editor with a `books/` subfolder (or the
  extension will create one under a workspace folder you pick).
- The [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer)
  extension, only if you want to use **Preview**.

## Install

From this folder:

```bash
npm install
npx vsce package
```

Then in VS Code: **Extensions view → "…" menu → Install from VSIX…** and
pick the generated `.vsix`.

## Use

Open a folder in VS Code (or a workspace that already has other books open),
then look for the **AvailaBooks Blog Tools icon in the activity bar**. Click
it to open the panel:

- **Book picker** (top of the panel) — click it to see a QuickPick of every
  blog already imported into this workspace's `books/` folder, plus an
  **Add Book…** entry.
- **Add Book…** — prompts for the blog's URL, signs you in to Google if
  needed, then imports every eligible post as a local `.html` file under
  `books/<blog name>/`, alongside a `blog.yaml` manifest that tracks each
  post's id and a content hash.
- **Sync Changes** — compares the local files, the blog, and the hashes
  recorded the last time this book was synced:
  - Changed only locally → pushes that post to Blogger.
  - Changed only on Blogger → pulls it into the local file.
  - Changed on **both** sides but landed on the same content → adopts that
    shared content, nothing to push or pull.
  - Changed on **both** sides with genuinely different content → syncing
    pauses and asks, post by post, whether to keep the local copy or the
    blog's copy (or to abort with nothing changed anywhere).
  - Unchanged → left alone.
  - New posts published directly on Blogger since the last sync are
    downloaded as new local files, the same way Add Book names them.
- **Consolidate Posts** — appears only when a book has posts spread across
  more than one year/month. Blogger fixes a post's permalink date at
  creation, so a post can't just be *moved*; instead, every post outside the
  book's majority month is re-created under that month (its old post
  deleted) and every post's cross-chapter links are rewritten from
  dated Blogger URLs to plain local file names. Confirms with you first,
  since it changes post URLs.
- **Preview** — builds a fully-rendered static copy of the book under
  `preview/<blog host>/` (one `.html` per post, using the blog's real
  live template around your local content) and opens it with Live Server.
  Requires all posts to share one year/month — run **Consolidate Posts**
  first if prompted, so cross-chapter links resolve correctly in the
  preview.
- **Sign In to Google** / **Sign Out of Google** — also available from the
  Command Palette (`AvailaBooks Blog Tools: Sign In to Google` / `Sign Out`).

### blog.yaml

One per book folder, alongside its post files:

```yaml
blogName: "F&P Intro"
blogId: "1234567890123456789"
blogUrl: "https://fpintro.blogspot.com/"
posts:
  - postTitle: "Chapter 5. Material Culture"
    postFileName: "05-material-culture.html"
    postSlug: "material-culture"
    postYear: "2026"
    postMonth: "09"
    postLabels: ["chapter", "5"]
    postId: "987654321098765432"
    contentHash: "3f9a2b..."
```

`postFileName` always matches the post's own published URL slug (e.g.
`https://fpintro.blogspot.com/2026/09/material-culture.html` →
`material-culture.html`), prefixed with its chapter number when the post
carries one as a Blogger label (see "Chapter numbering and required
labels" below). `postYear`/`postMonth` are read straight from that same
URL. `contentHash` is a sha256 of the post's HTML content as of the last
successful sync — the basis of the three-way comparison Sync Changes runs.

### Chapter numbering and required labels

A post is only imported/downloaded as a local file if it has **at least one
Blogger label** — an unlabeled post is skipped (logged to the output
channel) so drafts and unrelated posts on the same blog don't get pulled in
by accident.

A post labeled `"chapter"` must also carry its chapter number as a second,
plain-numeric label (e.g. labels `["chapter", "5"]`) — not parsed from the
title text, since titles are free-form and inconsistent. A `"chapter"`-
labeled post with no numeric label is skipped and logged, since there'd be
no way to know where it belongs in reading order. That numeric label also
becomes the local file's two-digit prefix (`05-material-culture.html`), so
chapter files sort in reading order. Non-chapter posts (e.g. a table of
contents, labeled `"toc"`) just need any label, and are saved unprefixed.

## Files

| File | Responsibility |
| --- | --- |
| `extension.js` | Activation, commands, the sidebar webview controller. |
| `addBook.js` | "Add Book…" — resolves a blog URL and imports its posts. |
| `publish.js` | "Sync Changes…" — the three-way diff/push/pull/conflict logic. |
| `consolidate.js` | "Consolidate Posts…" — re-dates outlier posts, rewrites links. |
| `preview.js` | "Preview…" — builds and serves a local static rendering of the book. |
| `bloggerApi.js` | Thin wrapper over the Blogger API v3 (list/get/insert/update/delete posts, resolve a blog by URL). |
| `authClient.js` | Google OAuth2 installed-app flow, token storage/refresh, retrying HTTP client. Exchanges tokens via `oauth-proxy/`, not Google's token endpoint directly. |
| `googleOAuthConfig.js` | The OAuth client id/redirect port/scopes and the deployed `oauth-proxy/` Worker's base URL (see setup below). |
| `oauth-proxy/` | Standalone Cloudflare Worker that holds the OAuth client *secret* and performs the actual code→token / refresh→token exchange with Google on the extension's behalf (see "OAuth token-exchange proxy" below). |
| `blogManifest.js` | Reads/writes `blog.yaml`, computes content hashes. |
| `postNaming.js` | Local file naming, chapter-number/label parsing, import eligibility. |
| `book.js` | Finds book folders under each workspace folder's `books/`. |
| `outputChannel.js` | Shared VS Code output channel every action logs to. |
| `media/` | The sidebar webview's HTML shell assets: icon, CSS, and client JS. |

## Google Cloud setup (already done for this extension; reference only)

This extension signs in to Google on the author's behalf using an installed-app
OAuth2 flow, via the client id already configured in `googleOAuthConfig.js`.
The professor-author never sees or enters these values — she only ever sees
Google's own consent screen. If you ever need to rotate that client or stand
up a new one:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a project (or pick an existing one).
2. **APIs & Services → Library** → search for **Blogger API v3** → Enable.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**.
   - Fill in the required app info (name, support email).
   - Add scope `https://www.googleapis.com/auth/blogger`.
   - While the app is "Testing" (unverified), add each author's Google
     account under **Test users** — required for anyone besides you to sign
     in until the app is verified.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**.
   - Copy the generated **Client ID** and **Client secret**.
5. Paste the **Client ID** into `googleOAuthConfig.js` (`CLIENT_ID`). The
   **Client secret** does *not* go in this file — see "OAuth token-exchange
   proxy" below for where it actually lives. If the console requires an
   exact redirect URI match, also register
   `http://127.0.0.1:<REDIRECT_PORT>/callback` (see that file).

A Desktop app client secret isn't a confidential value in the sense Google
means it (there's no way to keep it secret in code that ships to end users)
— see [Google's own docs](https://developers.google.com/identity/protocols/oauth2/native-app).
The real security boundary is the interactive consent screen every sign-in
shows, not this value.

## OAuth token-exchange proxy (`oauth-proxy/`)

Even though the client secret isn't meant to be *confidential*, it's still a
credential-shaped string, and the VS Code Marketplace's automated content
scanner blocks any `.vsix` upload containing one — it has no way to know
that context and treats it the same as a leaked API key. So the secret
doesn't ship in the extension at all: it lives in a small, standalone
Cloudflare Worker (`oauth-proxy/`) that does the actual code→token and
refresh→token exchange with Google on the extension's behalf.
`authClient.js` still opens Google's consent screen directly in the
author's browser and still catches the redirect itself — only the token
exchange goes through this Worker instead of straight to Google.

To deploy it (from `oauth-proxy/`):

```bash
npx wrangler deploy
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Then paste the URL `wrangler deploy` printed into `googleOAuthConfig.js`'s
`OAUTH_PROXY_BASE_URL`, and repackage the extension. `GOOGLE_CLIENT_ID` (not
secret) is already set in `oauth-proxy/wrangler.jsonc`'s `vars` — update it
there too if you ever rotate the OAuth client.

## Develop without installing

Open this folder in VS Code and press **F5** (Run and Debug → Run Extension).
It opens an Extension Development Host with the repo root (which contains
`books/`) as its workspace, with only this extension active in it.
