const vscode = require("vscode");

let channel;

/**
 * Creates the shared "AvailaBooks Blog Tools" output channel — VS Code's
 * bottom-panel Output tab — and ties its disposal to the extension's
 * lifetime. Every log line from a command-palette command or a sidebar
 * button ends up here.
 * @param {vscode.ExtensionContext} context
 */
function init(context) {
  channel = vscode.window.createOutputChannel("AvailaBooks Blog Tools");
  context.subscriptions.push(channel);
}

/**
 * Appends a line to the shared output channel.
 * @param {string} text
 */
function log(text) {
  channel.appendLine(text);
}

/**
 * Reveals the output channel in VS Code's bottom panel without stealing
 * focus from whatever editor is active.
 */
function show() {
  channel.show(true);
}

module.exports = { init, log, show };
