const fs = require("fs");
const path = require("path");

/**
 * True when dir directly contains a blog.yaml (i.e. is a tracked blog's
 * local folder).
 * @param {string} dir - Candidate absolute directory path.
 */
function isBookFolder(dir) {
  try {
    return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "blog.yaml"));
  } catch {
    return false;
  }
}

/**
 * Book folders directly inside a workspace folder's "books" subfolder.
 * @param {string} booksDir - Absolute path to a "books" folder.
 */
function booksDirectlyIn(booksDir) {
  let names;
  try {
    names = fs.readdirSync(booksDir);
  } catch {
    return [];
  }
  const books = [];
  for (const name of names.sort()) {
    const bookPath = path.join(booksDir, name);
    if (isBookFolder(bookPath)) {
      books.push({ label: name, path: bookPath });
    }
  }
  return books;
}

/**
 * All blog folders discoverable across the given workspace folders — each
 * open workspace folder's own "books" subfolder, one level down (matches
 * author-tools' "books/<name>/" convention, but only that one case: this
 * extension always uses a "books" folder, never a book opened as the
 * workspace root itself).
 * @param {string[]} workspaceFolderPaths - Absolute paths of open workspace folders.
 */
function findBooks(workspaceFolderPaths) {
  const books = [];
  const seen = new Set();
  for (const folderPath of workspaceFolderPaths) {
    for (const book of booksDirectlyIn(path.join(folderPath, "books"))) {
      if (!seen.has(book.path)) {
        seen.add(book.path);
        books.push(book);
      }
    }
  }
  return books;
}

/**
 * Creates <workspaceRoot>/books if it doesn't already exist yet, and
 * returns its path.
 * @param {string} workspaceRoot
 */
function ensureBooksDir(workspaceRoot) {
  const booksDir = path.join(workspaceRoot, "books");
  fs.mkdirSync(booksDir, { recursive: true });
  return booksDir;
}

// Characters that can't appear in a Windows/macOS/Linux folder name, plus
// leading/trailing dots and spaces (Windows trims/rejects those too).
const INVALID_FOLDER_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Turns a blog's display name into a safe, non-empty folder name.
 * @param {string} blogName
 */
function sanitizeFolderName(blogName) {
  const cleaned = blogName.replace(INVALID_FOLDER_CHARS, "").trim().replace(/\.+$/, "");
  return cleaned || "blog";
}

module.exports = { isBookFolder, findBooks, ensureBooksDir, sanitizeFolderName };
