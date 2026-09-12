// Wave-4 review fixes: ElevenLabs output_format mapping and Bedrock
// content-filter stop reasons.

import { assertEquals } from "@std/assert";
import { ElevenLabsAdapter } from "./elevenlabs.ts";
import { ProviderClient } from "./client.ts";
import { BedrockAdapter } from "./bedrock.ts";

Deno.test("elevenlabs: response_format maps to ElevenLabs output_format", async () => {
  const urls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
    );
  }) as typeof fetch;
  const adapter = new ElevenLabsAdapter(
    "el-key",
    "http://mock",
    new ProviderClient({ maxRetries: 0 }, fetchImpl),
  );

  const speak = async (response_format?: string) => {
    const res = await adapter.rawProxy(
      "/audio/speech",
      new Request("http://internal/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "eleven_multilingual_v2",
          input: "hei",
          voice: "Rachel",
          ...(response_format ? { response_format } : {}),
        }),
      }),
    );
    await res.body?.cancel();
  };

  await speak("mp3");
  await speak("opus");
  await speak("pcm");
  await speak("wav");
  await speak("flac"); // unknown -> omitted
  await speak(); // absent -> omitted

  assertEquals(urls, [
    "http://mock/v1/text-to-speech/Rachel?output_format=mp3_44100_128",
    "http://mock/v1/text-to-speech/Rachel?output_format=opus_48000_128",
    "http://mock/v1/text-to-speech/Rachel?output_format=pcm_44100",
    "http://mock/v1/text-to-speech/Rachel?output_format=pcm_44100",
    "http://mock/v1/text-to-speech/Rachel",
    "http://mock/v1/text-to-speech/Rachel",
  ]);
});

Deno.test("bedrock: filtered stop reasons map to content_filter", async () => {
  for (const stopReason of ["content_filtered", "guardrail_intervened"]) {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            output: { message: { content: [{ text: "blocked" }] } },
            stopReason,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      )) as typeof fetch;
    const adapter = new BedrockAdapter({
      region: "us-east-1",
      accessKeyId: "AKID",
      secretAccessKey: "secret",
      endpoint: "http://mock",
      fetchImpl,
    });
    const res = await adapter.chatCompletions({
      model: "anthropic.claude-3-haiku",
      messages: [{ role: "user", content: "hi" }],
    });
    const chat = await res.json() as {
      choices: Array<{ finish_reason: string }>;
    };
    assertEquals(chat.choices[0].finish_reason, "content_filter");
  }
});
