const fs = require("fs");
const path = require("path");
const https = require("https");
const vscode = require("vscode");
const { readManifest } = require("./blogManifest");
const consolidate = require("./consolidate");

const LIVE_SERVER_EXTENSION_ID = "ritwickdey.liveserver";
const LIVE_SERVER_GO_ONLINE_COMMAND = "extension.liveServer.goOnline";
const POST_BEGIN_MARKER = "<!--postBegin-->";
const POST_END_MARKER = "<!--postEnd-->";
const FETCH_TIMEOUT_MS = 15 * 1000;

/**
 * Whether the "Live Server" extension is installed — required to actually
 * serve the generated preview folder. Shows install instructions and
 * returns false if it isn't, rather than throwing, since this is an
 * expected first-run condition, not really an error.
 */
function ensureLiveServerInstalled() {
  if (vscode.extensions.getExtension(LIVE_SERVER_EXTENSION_ID)) {
    return true;
  }
  vscode.window.showErrorMessage(
    'Previewing a book locally requires the "Live Server" extension (publisher: Ritwick Dey). ' +
      'Install it from the Extensions view (search for "Live Server"), or run ' +
      '"code --install-extension ritwickdey.liveserver" from a terminal, then try Preview again.',
  );
  return false;
}

/**
 * Plain unauthenticated GET of a public page's HTML text — used to fetch a
 * post's actual rendered page (its template/theme), as distinct from the
 * Blogger API's `content` field, which is only the post's own body HTML
 * with none of the surrounding site chrome. Follows a handful of redirects
 * (Blogger sometimes 301s to a canonical host).
 * @param {string} url
 * @param {number} [redirectsLeft]
 * @returns {Promise<string>}
 */
function fetchPageText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.get(
      {
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AvailabooksBloggerTools/1.0)" },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, target).toString();
          resolve(fetchPageText(nextUrl, redirectsLeft - 1));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`Fetching ${url} failed: HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error(`Timed out fetching ${url}`)));
  });
}

/**
 * Groups posts by which template they need: two posts share a template
 * exactly when their non-numeric labels match (the numeric label is just a
 * chapter's sequence number, not a template kind) — e.g. ["chapter", "5"]
 * and ["chapter", "12"] are both kind "chapter".
 * @param {string[] | undefined} postLabels
 */
function templateKindFor(postLabels) {
  return (postLabels || [])
    .map((label) => label.trim().toLowerCase())
    .filter((label) => !/^\d+$/.test(label))
    .sort()
    .join(",");
}

/**
 * Builds "<blogUrl>/<year>/<month>/<slug>.html" regardless of whether
 * blogUrl already ends in a slash.
 */
function postPageUrl(blogUrl, year, month, slug) {
  const base = blogUrl.endsWith("/") ? blogUrl : `${blogUrl}/`;
  return `${base}${year}/${month}/${slug}.html`;
}

/**
 * Fetches one post kind's template by pulling the live rendered page for a
 * representative post of that kind, then splitting it around the
 * <!--postBegin-->/<!--postEnd--> markers the Availabooks template wraps
 * post content in: everything before postBegin is the header/chrome above
 * the post, everything after postEnd is the footer/chrome below it.
 * @param {string} blogUrl
 * @param {object} entry - A manifest post entry representative of this kind.
 * @param {(text: string) => void} log
 * @returns {Promise<{ header: string, footer: string }>}
 */
async function fetchTemplateFor(blogUrl, entry, log) {
  if (!entry.postYear || !entry.postMonth || !entry.postSlug) {
    throw new Error(
      `"${entry.postTitle}" is missing postYear/postMonth/postSlug in blog.yaml — re-download it (Sync Changes or re-add the book) before previewing.`,
    );
  }
  const pageUrl = postPageUrl(blogUrl, entry.postYear, entry.postMonth, entry.postSlug);
  log(`Fetching live template from ${pageUrl}…`);
  const pageHtml = await fetchPageText(pageUrl);

  const beginIndex = pageHtml.indexOf(POST_BEGIN_MARKER);
  const endIndex = pageHtml.indexOf(POST_END_MARKER);
  if (beginIndex === -1 || endIndex === -1) {
    throw new Error(
      `Could not find the ${POST_BEGIN_MARKER}/${POST_END_MARKER} markers in the live page at ${pageUrl} — ` +
        "is this book using the Availabooks Blogger template?",
    );
  }
  return {
    header: pageHtml.slice(0, beginIndex),
    footer: pageHtml.slice(endIndex + POST_END_MARKER.length),
  };
}

/**
 * Builds a local, fully-rendered static copy of the book (one .html file
 * per post, named by its postSlug so the already-localized cross-chapter
 * links resolve to sibling files) under preview/<blog host>/, then opens
 * the table-of-contents page and starts Live Server on it.
 * @param {string} bookDir
 * @param {(text: string) => void} log
 */
async function preview(bookDir, log) {
  if (!ensureLiveServerInstalled()) {
    return;
  }

  const manifest = readManifest(bookDir);
  if (!manifest) {
    throw new Error(`No blog.yaml found in ${bookDir}.`);
  }

  if (consolidate.hasDateOutliers(bookDir)) {
    vscode.window.showWarningMessage(
      'This book\'s posts aren\'t all in the same year and month yet. Run "Consolidate Posts" first, so ' +
        "cross-chapter links will actually resolve in the local preview.",
    );
    return;
  }

  let hostname;
  try {
    hostname = new URL(manifest.blogUrl).hostname;
  } catch {
    throw new Error(`blog.yaml has no valid blogUrl recorded for this book — re-add it to pick that up.`);
  }

  // bookDir is always "<workspaceRoot>/books/<bookFolder>" (see book.js), so
  // "preview" as a sister of "books" is two levels up from bookDir.
  const workspaceRoot = path.dirname(path.dirname(bookDir));
  const previewDir = path.join(workspaceRoot, "preview", hostname);
  fs.mkdirSync(previewDir, { recursive: true });

  log(`$ preview (in ${previewDir})`);

  const templatesByKind = new Map();
  let firstTocFileName = null;

  for (const entry of manifest.posts) {
    const kind = templateKindFor(entry.postLabels);
    let template = templatesByKind.get(kind);
    if (!template) {
      template = await fetchTemplateFor(manifest.blogUrl, entry, log);
      templatesByKind.set(kind, template);
      log(`Fetched template for post kind "${kind || "(unlabeled)"}".`);
    }

    const localPath = path.join(bookDir, entry.postFileName);
    const postBody = fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf8") : "";
    const fullHtml = template.header + postBody + template.footer;

    const outputFileName = `${entry.postSlug || entry.postFileName.replace(/\.html?$/i, "")}.html`;
    fs.writeFileSync(path.join(previewDir, outputFileName), fullHtml, "utf8");
    log(`Built "${outputFileName}".`);

    const isTocPost = (entry.postLabels || []).some((label) => label.trim().toLowerCase() === "toc");
    if (isTocPost) {
      // The "toc" post's own body is the book's table-of-contents JSON, not
      // HTML (see junk.html's loadBookInfo, which fetches this same content
      // from the blog's feed) — writing it out separately as plain toc.json
      // lets the preview's client-side code read it locally instead of
      // needing a live Blogger feed request.
      fs.writeFileSync(path.join(previewDir, "toc.json"), postBody, "utf8");
      log(`Wrote "toc.json" from "${entry.postFileName}".`);
    }

    if (!firstTocFileName && isTocPost) {
      firstTocFileName = outputFileName;
    }
  }

  log(`Done. Preview built at ${previewDir}.`);

  if (!firstTocFileName) {
    vscode.window.showWarningMessage(
      'No post labeled "toc" was found, so nothing was opened automatically — open a file in the preview ' +
        "folder yourself and start Live Server.",
    );
    return;
  }

  const tocDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(previewDir, firstTocFileName)));
  await vscode.window.showTextDocument(tocDocument, { preview: false });

  const liveServerExtension = vscode.extensions.getExtension(LIVE_SERVER_EXTENSION_ID);
  if (liveServerExtension && !liveServerExtension.isActive) {
    await liveServerExtension.activate();
  }
  await vscode.commands.executeCommand(LIVE_SERVER_GO_ONLINE_COMMAND);
}

module.exports = { preview };
