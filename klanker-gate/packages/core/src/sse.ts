export function createSSEResponse(
  stream: ReadableStream<Uint8Array>,
): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

export function sseEncode(data: string | object, event?: string): string {
  let output = "";
  if (event) {
    output += `event: ${event}\n`;
  }

  if (typeof data === "string") {
    const lines = data.split("\n");
    for (const line of lines) {
      output += `data: ${line}\n`;
    }
    output += `\n`;
  } else {
    output += `data: ${JSON.stringify(data)}\n\n`;
  }
  return output;
}
