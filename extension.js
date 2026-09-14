const vscode = require("vscode");
const path = require("path");
const sharedOutput = require("./outputChannel");
const authClient = require("./authClient");
const book = require("./book");
const addBook = require("./addBook");
const { publish } = require("./publish");
const { preview } = require("./preview");
const consolidate = require("./consolidate");
const { readManifest } = require("./blogManifest");

const SELECTED_BOOK_KEY = "bloggerTools.selectedBookPath";

/** @returns {string[]} */
function workspaceFolderPaths() {
  return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

/**
 * Resolves which open workspace folder a new book should be added under —
 * the only one, if there's just one; otherwise asks.
 */
async function pickWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    vscode.window.showErrorMessage("Open a folder in VS Code first.");
    return null;
  }
  if (folders.length === 1) {
    return folders[0].uri.fsPath;
  }
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, path: folder.uri.fsPath })),
    { title: "Add Book", placeHolder: "Which workspace folder should this book be added under?" },
  );
  return picked ? picked.path : null;
}

/**
 * Display label for a book folder: its blog.yaml blogName, falling back to
 * the folder name.
 * @param {string} bookDir
 */
function bookLabel(bookDir) {
  const manifest = readManifest(bookDir);
  return (manifest && manifest.blogName) || path.basename(bookDir);
}

/**
 * Owns the selected book and drives every webview/command action. Mirrors
 * author-tools' AuthorToolsController shape: one controller shared by every
 * attached webview, a workspaceState-persisted selected book, and a log
 * function that fans out to the shared output channel.
 */
class BloggerToolsController {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    this.webviews = new Set();
    this.running = false;
  }

  get selectedBookPath() {
    return this.context.workspaceState.get(SELECTED_BOOK_KEY);
  }

  async setSelectedBookPath(bookDir) {
    await this.context.workspaceState.update(SELECTED_BOOK_KEY, bookDir);
  }

  log(text) {
    sharedOutput.log(text);
  }

  /**
   * @param {vscode.Webview} webview
   */
  attach(webview) {
    this.webviews.add(webview);
    webview.onDidReceiveMessage((message) => this.handleMessage(message));
    this.pushState();
  }

  /**
   * @param {vscode.Webview} webview
   */
  detach(webview) {
    this.webviews.delete(webview);
  }

  async pushState() {
    const bookPath = this.selectedBookPath;
    const state = {
      bookLabel: bookPath ? bookLabel(bookPath) : "Select a Book…",
      hasBook: !!bookPath,
      hasDateOutliers: !!bookPath && consolidate.hasDateOutliers(bookPath),
      signedIn: await authClient.isSignedIn(),
      running: this.running,
    };
    for (const webview of this.webviews) {
      webview.postMessage({ type: "state", state });
    }
  }

  /**
   * @param {{ type: string }} message
   */
  async handleMessage(message) {
    if (!message) {
      return;
    }
    if (message.type === "pickBook") {
      await this.handlePickBook();
    } else if (message.type === "consolidatePosts") {
      await this.handleConsolidatePosts();
    } else if (message.type === "publish") {
      await this.handlePublish();
    } else if (message.type === "preview") {
      await this.handlePreview();
    } else if (message.type === "signIn") {
      await this.handleSignIn();
    } else if (message.type === "signOut") {
      await this.handleSignOut();
    }
  }

  /**
   * Shows a native QuickPick over every known book, plus an "Add Book…"
   * entry — looks and behaves like VS Code's own list pickers rather than
   * an in-webview <select>, matching author-tools' book picker.
   */
  async handlePickBook() {
    const books = book.findBooks(workspaceFolderPaths());
    const items = [
      ...books.map((b) => ({ label: b.label, description: b.path, bookPath: b.path })),
      { label: "$(plus) Add Book…", addBook: true },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Choose a book",
      placeHolder: "Select a book to work on, or add a new one",
    });
    if (!picked) {
      return;
    }
    if (picked.addBook) {
      await this.handleAddBook();
      return;
    }
    await this.setSelectedBookPath(picked.bookPath);
    await this.pushState();
  }

  async handleAddBook() {
    const workspaceRoot = await pickWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }
    await this.runExclusive("Adding book…", async () => {
      sharedOutput.show();
      const bookDir = await addBook.addBook(workspaceRoot, (text) => this.log(text));
      if (bookDir) {
        await this.setSelectedBookPath(bookDir);
      }
    });
  }

  async handleConsolidatePosts() {
    const bookPath = this.selectedBookPath;
    if (!bookPath) {
      vscode.window.showWarningMessage("Select a book first.");
      return;
    }
    await this.runExclusive("Consolidating posts…", async () => {
      sharedOutput.show();
      await consolidate.consolidatePosts(bookPath, (text) => this.log(text));
    });
  }

  async handlePublish() {
    const bookPath = this.selectedBookPath;
    if (!bookPath) {
      vscode.window.showWarningMessage("Select a book first.");
      return;
    }
    await this.runExclusive("Syncing changes…", async () => {
      sharedOutput.show();
      await publish(bookPath, (text) => this.log(text));
    });
  }

  async handlePreview() {
    const bookPath = this.selectedBookPath;
    if (!bookPath) {
      vscode.window.showWarningMessage("Select a book first.");
      return;
    }
    await this.runExclusive("Building preview…", async () => {
      sharedOutput.show();
      await preview(bookPath, (text) => this.log(text));
    });
  }

  async handleSignIn() {
    await this.runExclusive("Signing in to Google…", async () => {
      sharedOutput.show();
      await authClient.signIn((text) => this.log(text));
    });
  }

  async handleSignOut() {
    await authClient.signOut();
    await this.pushState();
  }

  /**
   * Runs one action at a time, surfacing progress/errors the same way for
   * every command (sidebar button or Command Palette): a progress
   * notification, output-channel logging, and a toast on failure.
   * @param {string} title
   * @param {() => Promise<void>} task
   */
  async runExclusive(title, task) {
    if (this.running) {
      vscode.window.showWarningMessage("AvailaBooks Blog Tools is already busy — please wait for it to finish.");
      return;
    }
    this.running = true;
    await this.pushState();
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
        await task();
      });
    } catch (error) {
      this.log(`\nError: ${error.message || error}`);
      vscode.window.showErrorMessage(String((error && error.message) || error));
    } finally {
      this.running = false;
      await this.pushState();
    }
  }
}

/**
 * Builds the webview document shell. The UI itself is mounted by
 * media/panel.js.
 * @param {vscode.Webview} webview
 * @param {vscode.Uri} extensionUri
 */
function getHtml(webview, extensionUri) {
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "panel.css"));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "panel.js"));
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AvailaBooks Blog Tools</title>
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body>
  <div class="app">
    <header class="top">
      <button type="button" id="book-picker" class="book-picker">
        <span id="book-label">Select a Book…</span>
        <span class="chevron">&#9662;</span>
      </button>
    </header>
    <p id="status-line" class="status"></p>
    <div class="tasks">
      <button type="button" id="consolidate-button" hidden>Consolidate Posts</button>
      <button type="button" id="publish-button">Sync Changes</button>
      <button type="button" id="preview-button">Preview</button>
    </div>
    <div class="account">
      <button type="button" id="signin-button" hidden>Sign In to Google</button>
      <button type="button" id="signout-button" hidden>Sign Out of Google</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

/**
 * Random nonce for the webview Content-Security-Policy.
 */
function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/**
 * Sidebar webview for the AvailaBooks Blog Tools activity bar.
 */
class BloggerToolsViewProvider {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {BloggerToolsController} controller
   */
  constructor(context, controller) {
    this.context = context;
    this.controller = controller;
  }

  /**
   * @param {vscode.WebviewView} webviewView
   */
  resolveWebviewView(webviewView) {
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webview.html = getHtml(webview, this.context.extensionUri);
    webviewView.onDidDispose(() => this.controller.detach(webview));
    this.controller.attach(webview);
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  sharedOutput.init(context);
  authClient.init(context);

  const controller = new BloggerToolsController(context);
  const provider = new BloggerToolsViewProvider(context, controller);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("bloggerTools.menu", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("bloggerTools.selectBook", () => controller.handlePickBook()),
    vscode.commands.registerCommand("bloggerTools.addBook", () => controller.handleAddBook()),
    vscode.commands.registerCommand("bloggerTools.consolidatePosts", () => controller.handleConsolidatePosts()),
    vscode.commands.registerCommand("bloggerTools.publish", () => controller.handlePublish()),
    vscode.commands.registerCommand("bloggerTools.preview", () => controller.handlePreview()),
    vscode.commands.registerCommand("bloggerTools.signIn", () => controller.handleSignIn()),
    vscode.commands.registerCommand("bloggerTools.signOut", () => controller.handleSignOut()),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
