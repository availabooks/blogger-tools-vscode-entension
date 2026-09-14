const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const bloggerApi = require("./bloggerApi");
const { hashContent, readManifest, writeManifest } = require("./blogManifest");

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The year/month combo shared by the most posts, and every post that
 * doesn't match it — including any post missing a year/month altogether,
 * since there's no way to confirm it belongs with the rest. Returns
 * majority: null when no post has a year/month to form a majority from.
 * @param {any[]} posts
 */
function computeMajorityAndOutliers(posts) {
  const counts = new Map();
  for (const entry of posts) {
    if (!entry.postYear || !entry.postMonth) {
      continue;
    }
    const key = `${entry.postYear}-${entry.postMonth}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size === 0) {
    return { majority: null, outliers: [] };
  }

  let majorityKey = null;
  let majorityCount = -1;
  for (const [key, count] of counts) {
    if (count > majorityCount) {
      majorityKey = key;
      majorityCount = count;
    }
  }
  const [majorityYear, majorityMonth] = majorityKey.split("-");
  const outliers = posts.filter((entry) => entry.postYear !== majorityYear || entry.postMonth !== majorityMonth);
  return { majority: { year: majorityYear, month: majorityMonth }, outliers };
}

/**
 * Rewrites any link in `content` that points at a post's dated Blogger
 * permalink — either the full URL (https://fpintro.blogspot.com/2026/09/material-culture.html)
 * or a root-relative path (/2026/09/material-culture.html) — down to a bare
 * local file name ("material-culture.html"). A no-op on content with
 * neither form. The full-URL form is only matched against this book's own
 * blog origin (from blogUrl), so a link to some unrelated blogspot site
 * isn't touched.
 * @param {string} content
 * @param {string | undefined} blogUrl
 */
function localizeLinks(content, blogUrl) {
  let origin = null;
  if (blogUrl) {
    try {
      origin = new URL(blogUrl).origin;
    } catch {
      origin = null;
    }
  }
  // The (?<=["']) lookbehind anchors every match to right after an
  // attribute's opening quote — without it, an unrelated domain that
  // happens to contain "/YYYY/MM/" further into its path (e.g.
  // https://example.com/2026/09/other.html) would still match on the bare
  // "/2026/09/other.html" tail, silently mangling a link to a site that
  // isn't this blog at all.
  const originPart = origin ? `(?:${escapeRegExp(origin)})?` : "";
  const pattern = new RegExp(`(?<=["'])${originPart}/\\d{4}/\\d{2}/([^"'\\s]+)`, "g");
  return content.replace(pattern, "$1");
}

/**
 * Whether this book currently has any post whose year/month differs from
 * the majority — drives the "Consolidate Posts" button's visibility.
 * @param {string} bookDir
 */
function hasDateOutliers(bookDir) {
  const manifest = readManifest(bookDir);
  if (!manifest) {
    return false;
  }
  return computeMajorityAndOutliers(manifest.posts).outliers.length > 0;
}

/**
 * Confirms with the author, then re-creates every post dated outside the
 * book's majority year/month under that majority month (Blogger fixes a
 * post's permalink date at creation — there's no way to just move an
 * existing post, so it's re-created and the original deleted), and
 * rewrites every post's content so a link to another chapter uses a bare
 * local file name instead of a dated path, now that they'll all share one
 * year/month.
 * @param {string} bookDir
 * @param {(text: string) => void} log
 */
async function consolidatePosts(bookDir, log) {
  const manifest = readManifest(bookDir);
  if (!manifest) {
    throw new Error(`No blog.yaml found in ${bookDir}.`);
  }

  const { majority, outliers } = computeMajorityAndOutliers(manifest.posts);
  if (!majority || outliers.length === 0) {
    vscode.window.showInformationMessage("Every post is already in the same year and month — nothing to consolidate.");
    return;
  }

  const proceed = await vscode.window.showWarningMessage(
    `${outliers.length} post(s) are not in the same year and month (${majority.year}-${majority.month}) as the ` +
      `majority of posts. Proceeding will re-create ${outliers.length === 1 ? "it" : "them"} under ` +
      `${majority.year}-${majority.month} and rewrite cross-chapter links throughout the book to local file names.`,
    { modal: true },
    "Proceed",
  );
  if (proceed !== "Proceed") {
    log("Consolidate Posts cancelled — no changes were made.");
    return;
  }

  log(`$ consolidate posts (in ${bookDir})`);
  const outlierSet = new Set(outliers);

  // Rewrite links in every post's current local content up front, so a
  // re-created outlier is created with already-corrected content instead of
  // needing a second write right after.
  const rewrittenByOldPostId = new Map();
  for (const entry of manifest.posts) {
    const localPath = path.join(bookDir, entry.postFileName);
    const original = fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf8") : "";
    const updated = localizeLinks(original, manifest.blogUrl);
    if (updated !== original) {
      rewrittenByOldPostId.set(entry.postId, updated);
    }
  }

  let recreated = 0;
  for (const entry of outliers) {
    const localPath = path.join(bookDir, entry.postFileName);
    const content =
      rewrittenByOldPostId.get(entry.postId) ?? (fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf8") : "");
    // blog.yaml already carries each post's labels (see addBook.js/publish.js)
    // for exactly this reason — only fall back to a live fetch for an older
    // book synced before postLabels existed.
    const labels = entry.postLabels || (await bloggerApi.getPost(manifest.blogId, entry.postId, log)).labels;
    // 12:01am on the 1st, not some day mid-month: if the majority month is
    // the current month, a later day/time could land in the future — which
    // Blogger would treat as a scheduled (not yet published) post — so the
    // very start of the month is the one point guaranteed not to be ahead
    // of "now" by the time this actually runs.
    const published = new Date(Date.UTC(Number(majority.year), Number(majority.month) - 1, 1, 0, 1)).toISOString();
    const newPost = await bloggerApi.insertPost(
      manifest.blogId,
      { title: entry.postTitle, content, labels, published },
      log,
    );
    await bloggerApi.deletePost(manifest.blogId, entry.postId, log);

    fs.writeFileSync(localPath, content, "utf8");
    entry.postId = newPost.id;
    entry.postYear = majority.year;
    entry.postMonth = majority.month;
    entry.contentHash = hashContent(content);
    log(`Re-created "${entry.postFileName}" under ${majority.year}-${majority.month} (new post id ${newPost.id}).`);
    recreated += 1;
  }

  let relinked = 0;
  for (const entry of manifest.posts) {
    if (outlierSet.has(entry)) {
      continue; // already written above with the same rewritten content
    }
    const newContent = rewrittenByOldPostId.get(entry.postId);
    if (newContent === undefined) {
      continue;
    }
    await bloggerApi.updatePost(manifest.blogId, entry.postId, { content: newContent }, log);
    fs.writeFileSync(path.join(bookDir, entry.postFileName), newContent, "utf8");
    entry.contentHash = hashContent(newContent);
    log(`Updated links in "${entry.postFileName}".`);
    relinked += 1;
  }

  writeManifest(bookDir, manifest);
  log(
    `Done. ${recreated} post(s) re-created under ${majority.year}-${majority.month}, ${relinked} post(s) had links updated.`,
  );
}

module.exports = { consolidatePosts, hasDateOutliers, computeMajorityAndOutliers, localizeLinks };
