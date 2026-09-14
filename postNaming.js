const path = require("path");

/**
 * A chapter post is required to carry its chapter number as one of its
 * Blogger labels (distinct from the "chapter" label itself) — e.g. a post
 * labeled ["chapter", "5"]. Title text isn't used for this: it's free-form
 * and inconsistent ("Chapter 5. Material Culture" vs "Chapter 11: ..." vs a
 * typo like "Chatper 1. ..."), while a label is an explicit, structured
 * value the author sets deliberately.
 * @param {string[] | undefined} labels
 * @returns {number | null}
 */
function chapterNumberFromLabels(labels) {
  if (!Array.isArray(labels)) {
    return null;
  }
  for (const label of labels) {
    if (/^\d+$/.test(label.trim())) {
      return parseInt(label, 10);
    }
  }
  return null;
}

/**
 * The local file name a post is saved/published under: the last path
 * segment of its own URL, e.g. https://fpintro.blogspot.com/2026/09/material-culture.html
 * -> "material-culture.html" — so the local file name always matches what
 * the post actually renders as. When the post carries a chapter number
 * (see chapterNumberFromLabels), that number is prefixed as two digits and
 * a hyphen (e.g. "05-material-culture.html") so chapter files sort in
 * reading order in a file listing; posts with no chapter number (front/back
 * matter like a table of contents) are left unprefixed.
 * @param {{ url: string, id: string, labels?: string[] }} post
 */
function postFileNameFor(post) {
  let base;
  try {
    const segment = new URL(post.url).pathname.split("/").filter(Boolean).pop();
    base = segment || `post-${post.id}.html`;
  } catch {
    base = `post-${post.id}.html`;
  }

  const chapterNumber = chapterNumberFromLabels(post.labels);
  if (chapterNumber === null) {
    return base;
  }
  return `${String(chapterNumber).padStart(2, "0")}-${base}`;
}

/**
 * The year and month a post was published under, straight from its own
 * permalink — Blogger permalinks are always "/YYYY/MM/slug.html" — so this
 * is recorded alongside the file name (see blogManifest.js) without ever
 * needing a separate API field for it. Returns null if the URL doesn't
 * match that shape.
 * @param {string} url
 * @returns {{ year: string, month: string } | null}
 */
function postDateFromUrl(url) {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    if (segments.length >= 3 && /^\d{4}$/.test(segments[0]) && /^\d{2}$/.test(segments[1])) {
      return { year: segments[0], month: segments[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * The post's own URL slug — the last path segment of its permalink with the
 * ".html" extension stripped, e.g.
 * https://fpintro.blogspot.com/2026/09/material-culture.html -> "material-culture".
 * Unlike postFileNameFor's result, this is never prefixed with a chapter
 * number or deduplicated — it's a plain record of what Blogger itself calls
 * the post, independent of local file-naming concerns. Returns null if the
 * URL can't be parsed.
 * @param {string} url
 * @returns {string | null}
 */
function postSlugFromUrl(url) {
  try {
    const segment = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (segment) {
      return segment.replace(/\.html?$/i, "");
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Makes postFileNameFor's result unique within one book — falls back to
 * "<name>-2.html", "<name>-3.html", ... on a collision, which should be
 * rare in practice.
 * @param {string} fileName
 * @param {Set<string>} used
 */
function dedupeFileName(fileName, used) {
  if (!used.has(fileName)) {
    used.add(fileName);
    return fileName;
  }
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let n = 2;
  let candidate = `${base}-${n}${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Whether a post is eligible to be imported/downloaded as a local file at
 * all, and if not, why — used by both Add Book and Sync Changes so a
 * skipped post is explained the same way in both places:
 *  - No labels at all: an author hasn't labeled it for the book yet.
 *  - Has the "chapter" label but no numeric label: labeled as a chapter,
 *    but missing the number that says where it belongs in reading order.
 * A post with some other label (e.g. front/back matter that isn't a
 * numbered chapter) is importable as long as it carries at least one label.
 * @param {{ title: string, labels?: string[] }} post
 * @returns {{ importable: true } | { importable: false, reason: string }}
 */
function importability(post) {
  const labels = Array.isArray(post.labels) ? post.labels : [];
  if (labels.length === 0) {
    return { importable: false, reason: `not downloaded because it has no label` };
  }
  const hasChapterLabel = labels.some((label) => label.trim().toLowerCase() === "chapter");
  if (hasChapterLabel && chapterNumberFromLabels(labels) === null) {
    return {
      importable: false,
      reason: `skipped for not having a number to indicate the sequence of the chapter in the finished book`,
    };
  }
  return { importable: true };
}

module.exports = {
  chapterNumberFromLabels,
  postFileNameFor,
  postDateFromUrl,
  postSlugFromUrl,
  dedupeFileName,
  importability,
};
