/**
 * The `data:` payloads of a Server-Sent Events body, in order. Comments (keep-alives) are skipped.
 * A fetch body rather than an EventSource: it can be aborted, and its end is the channel's end.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let end = buffer.indexOf('\n\n')
      while (end >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = block
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(line.startsWith('data: ') ? 6 : 5))
        if (data.length) yield data.join('\n')
        end = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}
