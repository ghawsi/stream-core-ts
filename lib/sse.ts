/**
 * Minimal Server-Sent Events reader for fetch() response bodies. Works in the
 * browser and in Node. Yields one item per event; multi-line `data:` fields
 * are joined with "\n" as the specification requires.
 */
export type SseMessage = { event: string | null; data: string }

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let event: string | null = null
  let data: string[] = []

  const flush = (): SseMessage | null => {
    const message = data.length > 0 ? { event, data: data.join("\n") } : null
    event = null
    data = []
    return message
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })

      let newline: number
      while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1))

        if (line === "") {
          const message = flush()
          if (message) yield message
          continue
        }
        if (line.startsWith(":")) continue // comment / keep-alive

        const colon = line.indexOf(":")
        const field = colon === -1 ? line : line.slice(0, colon)
        let fieldValue = colon === -1 ? "" : line.slice(colon + 1)
        if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1)

        if (field === "event") event = fieldValue
        else if (field === "data") data.push(fieldValue)
      }
    }
    if (buffer) {
      // A stream that ends without a final blank line still delivers its last event.
      if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""))
    }
    const last = flush()
    if (last) yield last
  } finally {
    // Frees the connection when the consumer stops early (for example on abort).
    await reader.cancel().catch(() => {})
  }
}
