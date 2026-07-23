// Minimal SSE client over fetch streaming for the opencode /event endpoint.
// The server emits `event: message\ndata: <json>\n\n` frames.

export interface SseEvent {
  type: string
  properties: Record<string, unknown>
}

export interface SseClient {
  close: () => void
}

export function openSseStream(
  url: string,
  onEvent: (event: SseEvent) => void,
  onError: (error: Error) => void,
): SseClient {
  const controller = new AbortController()
  let closed = false

  void (async () => {
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "text/event-stream" },
      })
      if (!response.ok || !response.body) {
        onError(new Error(`SSE connection failed: ${response.status}`))
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (!closed) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line.
        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          parseFrame(frame, onEvent)
          boundary = buffer.indexOf("\n\n")
        }
      }
    } catch (err) {
      if (!closed) onError(err instanceof Error ? err : new Error(String(err)))
    }
  })()

  return {
    close: () => {
      closed = true
      controller.abort()
    },
  }
}

function parseFrame(frame: string, onEvent: (event: SseEvent) => void) {
  let dataLines: string[] = []
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return
  try {
    const parsed = JSON.parse(dataLines.join("\n"))
    if (parsed && typeof parsed.type === "string") {
      onEvent({ type: parsed.type, properties: parsed.properties ?? {} })
    }
  } catch {
    // Ignore malformed frames (e.g. heartbeat keepalives).
  }
}
