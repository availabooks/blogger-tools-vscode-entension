const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yaml = require("js-yaml");

const MANIFEST_FILE_NAME = "blog.yaml";

/**
 * @typedef {{ postTitle: string, postFileName: string, postSlug?: string, postYear?: string, postMonth?: string, postLabels?: string[], postId: string, contentHash: string }} ManifestPost
 * @typedef {{ blogName: string, blogId: string, blogUrl: string, posts: ManifestPost[] }} Manifest
 */

/**
 * sha256 hex digest of a post's HTML content — the basis of the publish-time
 * three-way comparison (see publish.js): a post is "unchanged" exactly when
 * its current hash still matches the hash recorded the last time this
 * extension synced it, on whichever side (local file / Blogger) is being
 * checked.
 * @param {string} content
 */
function hashContent(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * @param {string} bookDir - Absolute path to a book folder.
 * @returns {Manifest | null}
 */
function readManifest(bookDir) {
  const manifestPath = path.join(bookDir, MANIFEST_FILE_NAME);
  try {
    const text = fs.readFileSync(manifestPath, "utf8");
    const parsed = yaml.load(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} bookDir - Absolute path to a book folder.
 * @param {Manifest} manifest
 */
function writeManifest(bookDir, manifest) {
  const manifestPath = path.join(bookDir, MANIFEST_FILE_NAME);
  fs.writeFileSync(manifestPath, yaml.dump(manifest, { lineWidth: -1 }), "utf8");
}

module.exports = { MANIFEST_FILE_NAME, hashContent, readManifest, writeManifest };
