const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const bloggerApi = require("./bloggerApi");
const { hashContent, readManifest, writeManifest } = require("./blogManifest");
const { postFileNameFor, postDateFromUrl, postSlugFromUrl, dedupeFileName, importability } = require("./postNaming");

/**
 * Reads the manifest and, for every tracked post, works out what's changed
 * on which side since the last sync — the "classify" step of the three-way
 * comparison (stored hash vs. current local hash vs. current remote hash).
 * Also returns any post that exists on the blog but isn't tracked yet (a
 * new chapter published directly on Blogger since the last sync) — Sync
 * Changes picks these up as new local files rather than only reconciling
 * already-tracked ones.
 * @param {string} bookDir
 * @param {(text: string) => void} log
 */
async function classifyPosts(bookDir, log) {
  const manifest = readManifest(bookDir);
  if (!manifest) {
    throw new Error(`No blog.yaml found in ${bookDir}.`);
  }

  const remotePosts = await bloggerApi.listAllPosts(manifest.blogId, log);
  const remoteById = new Map(remotePosts.map((post) => [post.id, post]));
  const trackedIds = new Set(manifest.posts.map((entry) => entry.postId));

  const items = [];
  for (const entry of manifest.posts) {
    const localPath = path.join(bookDir, entry.postFileName);
    const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf8") : "";
    const remotePost = remoteById.get(entry.postId);

    if (!remotePost) {
      log(`Warning: "${entry.postFileName}" (post ${entry.postId}) no longer exists on the blog — skipping.`);
      continue;
    }

    const localHash = hashContent(localContent);
    const remoteHash = hashContent(remotePost.content);
    const localChanged = localHash !== entry.contentHash;
    const remoteChanged = remoteHash !== entry.contentHash;

    let action;
    if (localChanged && remoteChanged) {
      // Both sides moved away from the last-synced hash, but if they landed
      // on the same content (e.g. the same edit made in both places), there's
      // nothing to actually reconcile — just adopt that shared hash so the
      // next publish doesn't flag it again.
      action = localHash === remoteHash ? "alreadyMatched" : "conflict";
    } else if (remoteChanged) {
      action = "pull";
    } else if (localChanged) {
      action = "push";
    } else {
      action = "noop";
    }

    items.push({ entry, localPath, localContent, remoteContent: remotePost.content, localHash, remoteHash, action });
  }

  const newRemotePosts = remotePosts.filter((post) => !trackedIds.has(post.id));

  return { manifest, items, newRemotePosts };
}

/**
 * Walks the author through every conflicting post one at a time, letting her
 * keep the local copy or the blog's copy for each. Returns a Map from postId
 * to "local" | "remote", or null if she chose to abort — in which case
 * nothing has been changed anywhere yet, since resolution happens entirely
 * before anything is applied.
 * @param {ReturnType<typeof classifyPosts> extends Promise<infer T> ? T["items"] : never} conflicts
 */
async function resolveConflicts(conflicts) {
  const choice = await vscode.window.showWarningMessage(
    `${conflicts.length} post(s) changed both locally and on the blog: ${conflicts
      .map((c) => c.entry.postFileName)
      .join(", ")}. Syncing is paused until you resolve each one.`,
    { modal: true },
    "Resolve One-by-One",
    "Abort Sync",
  );
  if (choice !== "Resolve One-by-One") {
    return null;
  }

  const resolutions = new Map();
  for (const conflict of conflicts) {
    // A modal dialog rather than a QuickPick: this is a plain binary choice,
    // and QuickPick's built-in filter/search box only invites the author to
    // type something that a two-item list has no use for.
    const picked = await vscode.window.showWarningMessage(
      `"${conflict.entry.postFileName}" changed both locally and on the blog — which copy should persist?`,
      { modal: true },
      "Keep Local Copy",
      "Keep Blog Version",
    );
    if (!picked) {
      return null;
    }
    resolutions.set(conflict.entry.postId, picked === "Keep Local Copy" ? "local" : "remote");
  }
  return resolutions;
}

/**
 * Applies every non-conflicting change, plus the author's resolutions for
 * conflicting ones. Mutates each item's manifest entry's contentHash in
 * place; does not write blog.yaml itself (see publish(), which writes it
 * once after this and downloadNewPosts have both run).
 * @param {object} manifest
 * @param {any[]} items
 * @param {Map<string, "local" | "remote">} resolutions
 * @param {(text: string) => void} log
 */
async function applyActions(manifest, items, resolutions, log) {
  let pushed = 0;
  let pulled = 0;
  let unchanged = 0;
  let alreadyMatched = 0;

  for (const item of items) {
    let effectiveAction = item.action;
    if (effectiveAction === "conflict") {
      effectiveAction = resolutions.get(item.entry.postId) === "local" ? "push" : "pull";
    }

    if (effectiveAction === "push") {
      await bloggerApi.updatePost(manifest.blogId, item.entry.postId, { content: item.localContent }, log);
      item.entry.contentHash = item.localHash;
      log(`Pushed local changes for "${item.entry.postFileName}" to the blog.`);
      pushed += 1;
    } else if (effectiveAction === "pull") {
      fs.writeFileSync(item.localPath, item.remoteContent, "utf8");
      item.entry.contentHash = item.remoteHash;
      log(`Pulled blog changes for "${item.entry.postFileName}" into the local file.`);
      pulled += 1;
    } else if (effectiveAction === "alreadyMatched") {
      item.entry.contentHash = item.localHash;
      log(`"${item.entry.postFileName}" changed on both sides but already matches — nothing to push or pull.`);
      alreadyMatched += 1;
    } else {
      unchanged += 1;
    }
  }

  return { pushed, pulled, alreadyMatched, unchanged };
}

/**
 * Downloads every post that's new on the blog since the last sync (not yet
 * in blog.yaml) as a new local file, named the same way Add Book names
 * files — including the "NN-" chapter-number prefix when the post carries
 * one — and appends a manifest entry for each. Mutates `manifest.posts` in
 * place; does not write blog.yaml itself (see publish()).
 * @param {string} bookDir
 * @param {object} manifest
 * @param {any[]} newRemotePosts
 * @param {(text: string) => void} log
 */
function downloadNewPosts(bookDir, manifest, newRemotePosts, log) {
  const usedFileNames = new Set(manifest.posts.map((entry) => entry.postFileName));
  let downloaded = 0;
  for (const post of newRemotePosts) {
    const eligibility = importability(post);
    if (!eligibility.importable) {
      log(`Skipped "${post.title}" — ${eligibility.reason}.`);
      continue;
    }

    const fileName = dedupeFileName(postFileNameFor(post), usedFileNames);
    fs.writeFileSync(path.join(bookDir, fileName), post.content, "utf8");
    const postDate = postDateFromUrl(post.url);
    const postSlug = postSlugFromUrl(post.url);
    manifest.posts.push({
      postTitle: post.title,
      postFileName: fileName,
      ...(postSlug ? { postSlug } : {}),
      ...(postDate ? { postYear: postDate.year, postMonth: postDate.month } : {}),
      ...(post.labels && post.labels.length > 0 ? { postLabels: post.labels } : {}),
      postId: post.id,
      contentHash: hashContent(post.content),
    });
    log(`Downloaded new post "${post.title}" from the blog as "${fileName}".`);
    downloaded += 1;
  }
  return downloaded;
}

/**
 * Publishes a book's local changes to Blogger, pulls in any changes made
 * directly on Blogger (including brand-new posts published there since the
 * last sync), and stops to ask the author when the same post changed on
 * both sides.
 * @param {string} bookDir
 * @param {(text: string) => void} log
 */
async function publish(bookDir, log) {
  log(`$ sync changes (in ${bookDir})`);
  const { manifest, items, newRemotePosts } = await classifyPosts(bookDir, log);

  const conflicts = items.filter((item) => item.action === "conflict");
  let resolutions = new Map();
  if (conflicts.length > 0) {
    const resolved = await resolveConflicts(conflicts);
    if (!resolved) {
      log("Sync aborted — no changes were made locally or on the blog.");
      return;
    }
    resolutions = resolved;
  }

  const counts = await applyActions(manifest, items, resolutions, log);
  const downloaded = downloadNewPosts(bookDir, manifest, newRemotePosts, log);

  writeManifest(bookDir, manifest);
  log(
    `Done. ${counts.pushed} pushed, ${counts.pulled} pulled, ${counts.alreadyMatched} already matched, ` +
      `${downloaded} new post(s) downloaded, ${counts.unchanged} unchanged.`,
  );
}

module.exports = { publish };
