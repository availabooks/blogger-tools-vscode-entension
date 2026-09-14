const vscode = acquireVsCodeApi();

const bookLabelEl = document.getElementById("book-label");
const statusLineEl = document.getElementById("status-line");
const consolidateButton = document.getElementById("consolidate-button");
const publishButton = document.getElementById("publish-button");
const previewButton = document.getElementById("preview-button");
const signInButton = document.getElementById("signin-button");
const signOutButton = document.getElementById("signout-button");

document.getElementById("book-picker").addEventListener("click", () => {
  vscode.postMessage({ type: "pickBook" });
});
consolidateButton.addEventListener("click", () => {
  vscode.postMessage({ type: "consolidatePosts" });
});
publishButton.addEventListener("click", () => {
  vscode.postMessage({ type: "publish" });
});
previewButton.addEventListener("click", () => {
  vscode.postMessage({ type: "preview" });
});
signInButton.addEventListener("click", () => {
  vscode.postMessage({ type: "signIn" });
});
signOutButton.addEventListener("click", () => {
  vscode.postMessage({ type: "signOut" });
});

/**
 * Renders one state snapshot pushed from the extension (see
 * BloggerToolsController.pushState in extension.js).
 * @param {{ bookLabel: string, hasBook: boolean, hasDateOutliers: boolean, signedIn: boolean, running: boolean }} state
 */
function render(state) {
  bookLabelEl.textContent = state.bookLabel;

  statusLineEl.textContent = state.running
    ? "Working…"
    : state.signedIn
      ? "Signed in to Google"
      : "Not signed in to Google";

  consolidateButton.hidden = !state.hasDateOutliers;
  consolidateButton.disabled = state.running || !state.hasBook;
  publishButton.disabled = state.running || !state.hasBook;
  previewButton.disabled = state.running || !state.hasBook;
  signInButton.hidden = state.signedIn;
  signInButton.disabled = state.running;
  signOutButton.hidden = !state.signedIn;
  signOutButton.disabled = state.running;
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message && message.type === "state") {
    render(message.state);
  }
});
