// This method is called when your extension is deactivated
export function deactivate() {}

import * as vscode from "vscode"
import {
  DIFF_SCHEME,
  diffProvider,
  diffUris,
  nextToken,
  setDiffContent,
  applyPatch,
  extractPendingFiles,
  readFile,
  baseName,
  type PendingFile,
} from "./diff-provider"
import { openSseStream, type SseClient } from "./sse-client"

const TERMINAL_NAME = "abxglia-opencode"
const CONFIG_SECTION = "abxglia-opencode"

// Reads a config value from the abxglia-opencode settings section.
function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration(CONFIG_SECTION).get<T>(key, fallback)
}

// Tracks one spawned opencode server: its port, the SSE subscription, and any
// open diff tabs keyed by requestID so commands can resolve the right permission.
interface OpencodeServer {
  port: number
  sse: SseClient | undefined
  pendingDiffs: Map<string, vscode.Tab[]>
}

const servers = new Map<number, OpencodeServer>()

export function activate(context: vscode.ExtensionContext) {
  // Register the virtual-document provider for diff content.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),
  )

  const openNewTerminalDisposable = vscode.commands.registerCommand(
    "abxglia-opencode.openNewTerminal",
    async () => {
      await openTerminal()
    },
  )

  const openTerminalDisposable = vscode.commands.registerCommand(
    "abxglia-opencode.openTerminal",
    async () => {
      const existingTerminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
      if (existingTerminal) {
        existingTerminal.show()
        return
      }
      await openTerminal()
    },
  )

  const addFilepathDisposable = vscode.commands.registerCommand(
    "abxglia-opencode.addFilepathToTerminal",
    async () => {
      const fileRef = getActiveFile()
      if (!fileRef) return

      const terminal = vscode.window.activeTerminal
      if (!terminal) return

      if (terminal.name === TERMINAL_NAME) {
        // @ts-ignore
        const port = terminal.creationOptions.env?.["_EXTENSION_OPENCODE_PORT"]
        port ? await appendPrompt(parseInt(port), fileRef) : terminal.sendText(fileRef, false)
        terminal.show()
      }
    },
  )

  // --- IDE diff review commands ---
  const acceptChange = vscode.commands.registerCommand("abxglia-opencode.acceptChange", async () => {
    await resolveFromActiveDiff("once")
  })
  const acceptAlwaysChange = vscode.commands.registerCommand(
    "abxglia-opencode.acceptAlwaysChange",
    async () => {
      await resolveFromActiveDiff("always")
    },
  )
  const rejectChange = vscode.commands.registerCommand("abxglia-opencode.rejectChange", async () => {
    await resolveFromActiveDiff("reject")
  })
  const rejectChangeWithFeedback = vscode.commands.registerCommand(
    "abxglia-opencode.rejectChangeWithFeedback",
    async () => {
      const feedback = await vscode.window.showInputBox({
        prompt: "Feedback to send back to the agent",
        placeHolder: "What should the agent change?",
      })
      if (feedback === undefined) return
      await resolveFromActiveDiff("reject", feedback)
    },
  )

  context.subscriptions.push(
    openNewTerminalDisposable,
    openTerminalDisposable,
    addFilepathDisposable,
    acceptChange,
    acceptAlwaysChange,
    rejectChange,
    rejectChangeWithFeedback,
  )

  async function openTerminal() {
    const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
    const opencodePath = config<string>("path", "opencode")
    const dataDir = config<string>("dataDir", "")

    // Pass OPENCODE_DATA_DIR through the terminal env so the dev fork isolates
    // its sessions/db from the released opencode.
    const terminalEnv: Record<string, string> = {
      _EXTENSION_OPENCODE_PORT: port.toString(),
      OPENCODE_CALLER: "vscode",
    }
    if (dataDir) terminalEnv["OPENCODE_DATA_DIR"] = dataDir

    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      iconPath: {
        light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
        dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
      },
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      env: terminalEnv,
    })

    terminal.show()
    // Launch in serve mode (HTTP server only) to avoid TUI rendering issues in
    // integrated terminals. The web UI at localhost:PORT/app provides the chat
    // interface; the IDE diff feature works identically over the HTTP API.
    terminal.sendText(`${opencodePath} serve --port ${port}`)

    // Wait for the terminal to be ready
    let tries = 30
    let connected = false
    do {
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        await fetch(`http://localhost:${port}/app`)
        connected = true
        break
      } catch {}

      tries--
    } while (tries > 0)

    if (connected) {
      // Open the web UI in a Cursor editor tab (simpleBrowser).
      await vscode.commands.executeCommand("simpleBrowser.show", `http://localhost:${port}/app`)
      await activateIdeDiffReview(port, context)
    }
  }

  async function appendPrompt(port: number, text: string) {
    await fetch(`http://localhost:${port}/tui/append-prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    })
  }

  function getActiveFile() {
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) return

    const document = activeEditor.document
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    if (!workspaceFolder) return

    const relativePath = vscode.workspace.asRelativePath(document.uri)
    let filepathWithAt = `@${relativePath}`

    const selection = activeEditor.selection
    if (!selection.isEmpty) {
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1

      if (startLine === endLine) {
        filepathWithAt += `#L${startLine}`
      } else {
        filepathWithAt += `#L${startLine}-${endLine}`
      }
    }

    return filepathWithAt
  }
}

// Activate IDE diff review for a spawned server: tell the server we're
// listening, subscribe to permission events, and open diff tabs.
async function activateIdeDiffReview(port: number, context: vscode.ExtensionContext) {
  if (!config<boolean>("ideDiffReview", true)) return

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""
  try {
    await fetch(`http://localhost:${port}/ide-diff/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceFolder }),
    })
  } catch {
    // Server may be older than this feature; skip activation silently.
    return
  }

  const server: OpencodeServer = { port, sse: undefined, pendingDiffs: new Map() }
  servers.set(port, server)

  const sseUrl = `http://localhost:${port}/event?directory=${encodeURIComponent(workspaceFolder)}`
  server.sse = openSseStream(
    sseUrl,
    (event) => {
      if (event.type === "permission.asked") {
        void handlePermissionAsked(port, event.properties)
      }
    },
    () => {
      // On disconnect, attempt a single reconnect after a short delay.
      setTimeout(() => {
        if (servers.has(port)) void activateIdeDiffReview(port, context)
      }, 3000)
    },
  )
}

async function handlePermissionAsked(port: number, properties: Record<string, unknown>) {
  if (properties.permission !== "edit") return
  const requestID = typeof properties.id === "string" ? properties.id : undefined
  if (!requestID) return

  const metadata = (properties.metadata ?? {}) as Record<string, unknown>
  const pendingFiles = extractPendingFiles(metadata)
  if (pendingFiles.length === 0) return

  const token = nextToken()
  const worktree = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""

  for (const file of pendingFiles) {
    await showDiffTab(port, token, file, worktree)
  }

  // Track the active tab so commands can resolve this request.
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
  if (activeTab) {
    const server = servers.get(port)
    if (server) server.pendingDiffs.set(requestID, [activeTab].filter(Boolean) as vscode.Tab[])
  }
}

async function showDiffTab(port: number, token: number, file: PendingFile, worktree: string) {
  const absolutePath = file.filePath.startsWith("/") ? file.filePath : `${worktree}/${file.filePath}`
  const oldText = readFile(absolutePath)
  const newText = applyPatch(oldText, file.patch)
  if (newText === null) return

  const { oldUri, newUri } = diffUris(token, file.filePath)
  setDiffContent(oldUri, oldText)
  setDiffContent(newUri, newText)

  await vscode.commands.executeCommand(
    "vscode.diff",
    oldUri,
    newUri,
    `${baseName(file.filePath)} (opencode review)`,
    { preview: false, viewColumn: vscode.ViewColumn.Active },
  )
}

// Resolve the permission request associated with the currently-active diff tab.
async function resolveFromActiveDiff(reply: "once" | "always" | "reject", message?: string) {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
  if (!activeTab) return

  // Find the requestID whose tracked tab is the active one.
  let requestID: string | undefined
  let port: number | undefined
  for (const [p, server] of servers) {
    for (const [id, tabs] of server.pendingDiffs) {
      if (tabs.includes(activeTab)) {
        requestID = id
        port = p
        break
      }
    }
    if (requestID) break
  }
  if (!requestID || port === undefined) return

  await fetch(`http://localhost:${port}/permission/${requestID}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply, ...(message ? { message } : {}) }),
  })

  // Close the diff tab(s) for this request.
  const server = servers.get(port)
  if (server) {
    const tabs = server.pendingDiffs.get(requestID)
    if (tabs) {
      for (const tab of tabs) {
        await vscode.window.tabGroups.close(tab)
      }
      server.pendingDiffs.delete(requestID)
    }
  }
}
