const authClient = require("./authClient");

const API_BASE = "https://www.googleapis.com/blogger/v3";

/**
 * Resolves a blog's numeric id and display name from its public URL — what
 * "Add Book" starts from, since a non-technical author only has the blog's
 * URL, not its id.
 * @param {string} blogUrl
 * @param {(text: string) => void} [log]
 * @returns {Promise<{ id: string, name: string, url: string }>}
 */
async function resolveBlogByUrl(blogUrl, log) {
  const url = `${API_BASE}/blogs/byurl?url=${encodeURIComponent(blogUrl)}`;
  const blog = await authClient.apiRequest(url, {}, log);
  return { id: blog.id, name: blog.name, url: blog.url };
}

/**
 * Every post on a blog, each with { id, title, content, url, labels } —
 * content is the post's raw HTML body, the same thing a reader's browser
 * fetches and what gets written to the local file; labels is the post's
 * Blogger tags, which is where a chapter's required numeric label lives
 * (see postNaming.js). Paginates through nextPageToken since a book can
 * have more posts than fit in one page.
 * @param {string} blogId
 * @param {(text: string) => void} [log]
 * @returns {Promise<{ id: string, title: string, content: string, url: string, labels: string[] }[]>}
 */
async function listAllPosts(blogId, log) {
  const posts = [];
  let pageToken;
  do {
    const url = new URL(`${API_BASE}/blogs/${blogId}/posts`);
    url.searchParams.set("maxResults", "500");
    url.searchParams.set("fetchBodies", "true");
    url.searchParams.set("status", "live");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }
    const page = await authClient.apiRequest(url.toString(), {}, log);
    for (const item of page.items || []) {
      posts.push({ id: item.id, title: item.title, content: item.content, url: item.url, labels: item.labels || [] });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return posts;
}

/**
 * A single post's current content, for the publish-time comparison against
 * what's stored locally.
 * @param {string} blogId
 * @param {string} postId
 * @param {(text: string) => void} [log]
 * @returns {Promise<{ id: string, title: string, content: string, url: string, labels: string[] }>}
 */
async function getPost(blogId, postId, log) {
  const url = `${API_BASE}/blogs/${blogId}/posts/${postId}?fetchBody=true`;
  const post = await authClient.apiRequest(url, {}, log);
  return { id: post.id, title: post.title, content: post.content, url: post.url, labels: post.labels || [] };
}

/**
 * Pushes local edits back to Blogger. A PATCH, not PUT — only the fields
 * given are changed; everything else about the post (labels, publish
 * status, ...) is left alone.
 * @param {string} blogId
 * @param {string} postId
 * @param {{ title?: string, content: string }} fields
 * @param {(text: string) => void} [log]
 */
async function updatePost(blogId, postId, fields, log) {
  const url = `${API_BASE}/blogs/${blogId}/posts/${postId}`;
  return authClient.apiRequest(url, { method: "PATCH", body: fields }, log);
}

/**
 * Creates a brand-new post, optionally backdated via `published` (an
 * RFC3339 timestamp) — Blogger fixes a post's permalink date at creation
 * time and there's no API to move an existing post to a different
 * year/month, so consolidate.js re-creates a post here rather than editing
 * it in place, then deletes the original (see deletePost).
 * @param {string} blogId
 * @param {{ title: string, content: string, labels?: string[], published?: string }} fields
 * @param {(text: string) => void} [log]
 * @returns {Promise<{ id: string, title: string, content: string, url: string, labels: string[] }>}
 */
async function insertPost(blogId, fields, log) {
  const url = `${API_BASE}/blogs/${blogId}/posts`;
  const post = await authClient.apiRequest(url, { method: "POST", body: fields }, log);
  return { id: post.id, title: post.title, content: post.content, url: post.url, labels: post.labels || [] };
}

/**
 * Permanently deletes a post — used by consolidate.js right after
 * successfully re-creating it under a new year/month, so the blog doesn't
 * end up with a duplicate.
 * @param {string} blogId
 * @param {string} postId
 * @param {(text: string) => void} [log]
 */
async function deletePost(blogId, postId, log) {
  const url = `${API_BASE}/blogs/${blogId}/posts/${postId}`;
  return authClient.apiRequest(url, { method: "DELETE" }, log);
}

module.exports = { resolveBlogByUrl, listAllPosts, getPost, updatePost, insertPost, deletePost };
