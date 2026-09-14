const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const bloggerApi = require("./bloggerApi");
const book = require("./book");
const { hashContent, writeManifest } = require("./blogManifest");
const { postFileNameFor, postDateFromUrl, postSlugFromUrl, dedupeFileName, importability } = require("./postNaming");

/**
 * Prompts for a blog URL, imports every one of its posts as a local file,
 * and writes the book's blog.yaml manifest. Returns the new book folder's
 * absolute path, or null if the author cancelled.
 * @param {string} workspaceRoot - Absolute path of the workspace folder to add the book under.
 * @param {(text: string) => void} log
 * @returns {Promise<string | null>}
 */
async function addBook(workspaceRoot, log) {
  const blogUrl = await vscode.window.showInputBox({
    title: "Add Book",
    prompt: "Enter the URL of the Blogger blog to import",
    placeHolder: "https://your-book.blogspot.com",
    ignoreFocusOut: true,
    validateInput: (value) => {
      try {
        new URL(value.trim());
        return null;
      } catch {
        return "Enter a full URL, e.g. https://your-book.blogspot.com";
      }
    },
  });
  if (!blogUrl) {
    return null;
  }

  log(`$ add book from ${blogUrl}`);
  const blog = await bloggerApi.resolveBlogByUrl(blogUrl.trim(), log);
  log(`Found blog "${blog.name}" (id ${blog.id}). Fetching posts…`);

  const posts = await bloggerApi.listAllPosts(blog.id, log);
  log(`Fetched ${posts.length} post(s).`);

  const booksDir = book.ensureBooksDir(workspaceRoot);
  const bookDir = path.join(booksDir, book.sanitizeFolderName(blog.name));
  fs.mkdirSync(bookDir, { recursive: true });

  const usedFileNames = new Set();
  const manifestPosts = [];
  let skipped = 0;
  for (const post of posts) {
    const eligibility = importability(post);
    if (!eligibility.importable) {
      log(`Skipped "${post.title}" — ${eligibility.reason}.`);
      skipped += 1;
      continue;
    }

    const fileName = dedupeFileName(postFileNameFor(post), usedFileNames);
    fs.writeFileSync(path.join(bookDir, fileName), post.content, "utf8");
    const postDate = postDateFromUrl(post.url);
    const postSlug = postSlugFromUrl(post.url);
    manifestPosts.push({
      postTitle: post.title,
      postFileName: fileName,
      ...(postSlug ? { postSlug } : {}),
      ...(postDate ? { postYear: postDate.year, postMonth: postDate.month } : {}),
      ...(post.labels && post.labels.length > 0 ? { postLabels: post.labels } : {}),
      postId: post.id,
      contentHash: hashContent(post.content),
    });
  }

  writeManifest(bookDir, { blogName: blog.name, blogId: blog.id, blogUrl: blog.url, posts: manifestPosts });
  log(`Wrote ${manifestPosts.length} file(s) to ${bookDir}${skipped > 0 ? ` (${skipped} post(s) skipped)` : ""}.`);

  return bookDir;
}

module.exports = { addBook };
