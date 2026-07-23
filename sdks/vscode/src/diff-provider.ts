import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"

// A virtual-document provider that serves reconstructed old/new file content for
// the IDE diff-review view. Each pending edit gets a unique token so VS Code's
// per-URI virtual-doc cache never shows stale content for repeat edits.

export const DIFF_SCHEME = "opencodediff"

const contentMap = new Map<string, string>()
const changeEmitter = new vscode.EventEmitter<vscode.Uri>()
let diffToken = 0

export const diffProvider = new (class implements vscode.TextDocumentContentProvider {
  readonly onDidChange = changeEmitter.event
  provideTextDocumentContent(uri: vscode.Uri): string {
    return contentMap.get(uri.toString()) ?? ""
  }
})()

export function nextToken(): number {
  return ++diffToken
}

export function setDiffContent(uri: vscode.Uri, text: string) {
  contentMap.set(uri.toString(), text)
  changeEmitter.fire(uri)
}

// Build the old/new URIs for one file in a pending change. The token makes the
// URI unique per diff so a second edit to the same file is not served from cache.
export function diffUris(token: number, filePath: string): { oldUri: vscode.Uri; newUri: vscode.Uri } {
  const encoded = encodeURIComponent(filePath)
  return {
    oldUri: vscode.Uri.parse(`${DIFF_SCHEME}:/old/${token}/${encoded}`),
    newUri: vscode.Uri.parse(`${DIFF_SCHEME}:/new/${token}/${encoded}`),
  }
}

// Apply a unified diff patch to old text, returning the new text. Returns null
// if the patch cannot be applied cleanly.
export function applyPatch(oldText: string, patch: string): string | null {
  const oldLines = oldText.split("\n")
  const result: string[] = []
  const patchLines = patch.split("\n")
  let oldIdx = 0
  let i = 0

  // Skip patch header lines (--- / +++ / @@ context) until the first hunk.
  while (i < patchLines.length && !patchLines[i].startsWith("@@")) i++

  while (i < patchLines.length) {
    const line = patchLines[i]
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))?/)
      if (!match) return null
      const startLine = parseInt(match[1], 10) - 1
      // Copy unchanged lines before this hunk.
      while (oldIdx < startLine && oldIdx < oldLines.length) {
        result.push(oldLines[oldIdx])
        oldIdx++
      }
      i++
      continue
    }
    if (line.startsWith(" ")) {
      // Context line.
      if (oldIdx < oldLines.length) {
        result.push(oldLines[oldIdx])
        oldIdx++
      }
      i++
      continue
    }
    if (line.startsWith("-")) {
      // Removed line: skip in old.
      oldIdx++
      i++
      continue
    }
    if (line.startsWith("+")) {
      // Added line: include in result.
      result.push(line.slice(1))
      i++
      continue
    }
    // Empty line or "\ No newline at end of file" — treat as context boundary.
    if (line === "") {
      i++
      continue
    }
    i++
  }
  // Copy remaining unchanged lines after the last hunk.
  while (oldIdx < oldLines.length) {
    result.push(oldLines[oldIdx])
    oldIdx++
  }
  return result.join("\n")
}

// Extract the set of file paths and their patches from a permission.asked event.
// edit/write put a single unified diff in metadata.diff keyed against
// metadata.filepath. apply_patch puts per-file patches in metadata.files.
export interface PendingFile {
  filePath: string
  patch: string
}

export function extractPendingFiles(metadata: Record<string, unknown>): PendingFile[] {
  const files = metadata.files
  if (Array.isArray(files)) {
    return files
      .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
      .map((f) => ({
        filePath: String(f.filePath ?? f.relativePath ?? ""),
        patch: typeof f.patch === "string" ? f.patch : "",
      }))
      .filter((f) => f.filePath && f.patch)
  }
  const diff = typeof metadata.diff === "string" ? metadata.diff : undefined
  const filepath = typeof metadata.filepath === "string" ? metadata.filepath : undefined
  if (diff && filepath) {
    // filepath may be comma-separated for multi-file patches, but edit/write are single-file.
    const first = filepath.split(",")[0].trim()
    return [{ filePath: first, patch: diff }]
  }
  return []
}

// Read a file from disk, returning empty string if it doesn't exist (new file).
export function readFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8")
  } catch {
    return ""
  }
}

export function baseName(filePath: string): string {
  return path.basename(filePath)
}
