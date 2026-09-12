import { assertEquals } from "@std/assert";
import { DEFAULT_GEMINI_PCM, detectAudioMimeType, pcmToWav } from "./audio.ts";

function bytes(...values: Array<number | string>): Uint8Array {
  const out: number[] = [];
  for (const v of values) {
    if (typeof v === "string") {
      for (let i = 0; i < v.length; i++) out.push(v.charCodeAt(i));
    } else {
      out.push(v);
    }
  }
  return new Uint8Array(out);
}

Deno.test("DEFAULT_GEMINI_PCM pins the Gemini TTS wire format", () => {
  assertEquals(DEFAULT_GEMINI_PCM, {
    sampleRate: 24000,
    channels: 1,
    bitsPerSample: 16,
  });
});

Deno.test("pcmToWav emits the exact 44-byte header (golden bytes)", () => {
  const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]));
  // Golden header for 4 PCM bytes at s16le/24000/mono, byte-identical to the
  // Go ConvertPCMToWAV layout (all fields little-endian).
  const golden = new Uint8Array([
    0x52,
    0x49,
    0x46,
    0x46, // "RIFF"
    0x28,
    0x00,
    0x00,
    0x00, // fileSize = 36 + 4
    0x57,
    0x41,
    0x56,
    0x45, // "WAVE"
    0x66,
    0x6d,
    0x74,
    0x20, // "fmt "
    0x10,
    0x00,
    0x00,
    0x00, // subchunk1 size = 16 (PCM)
    0x01,
    0x00, // audio format = 1 (PCM)
    0x01,
    0x00, // channels = 1
    0xc0,
    0x5d,
    0x00,
    0x00, // sample rate = 24000
    0x80,
    0xbb,
    0x00,
    0x00, // byte rate = 48000
    0x02,
    0x00, // block align = 2
    0x10,
    0x00, // bits per sample = 16
    0x64,
    0x61,
    0x74,
    0x61, // "data"
    0x04,
    0x00,
    0x00,
    0x00, // data length = 4
    0x01,
    0x02,
    0x03,
    0x04, // PCM payload
  ]);
  assertEquals(wav, golden);
});

Deno.test("pcmToWav of empty PCM is a bare 44-byte header", () => {
  const wav = pcmToWav(new Uint8Array(0));
  assertEquals(wav.length, 44);
  const view = new DataView(wav.buffer);
  assertEquals(view.getUint32(4, true), 36); // fileSize = 36 + 0
  assertEquals(view.getUint32(40, true), 0); // data length
});

Deno.test("pcmToWav honors a custom PCM config", () => {
  const wav = pcmToWav(new Uint8Array([0, 0]), {
    sampleRate: 44100,
    channels: 2,
    bitsPerSample: 16,
  });
  const view = new DataView(wav.buffer);
  assertEquals(view.getUint16(22, true), 2); // channels
  assertEquals(view.getUint32(24, true), 44100); // sample rate
  assertEquals(view.getUint32(28, true), 176400); // byte rate = 44100*2*2
  assertEquals(view.getUint16(32, true), 4); // block align
});

Deno.test("detectAudioMimeType sniffs magic bytes (Go order and fallbacks)", () => {
  const cases: Array<[string, Uint8Array, string]> = [
    ["wav", bytes("RIFF", 0, 0, 0, 0, "WAVE"), "audio/wav"],
    ["mp3 id3", bytes("ID3", 4, 0), "audio/mp3"],
    ["aac adif", bytes("ADIF", 0), "audio/aac"],
    // ADTS frame sync (0xFFF, layer bits 00) must win over the MP3 sync.
    ["aac adts", bytes(0xff, 0xf1, 0x50, 0x80), "audio/aac"],
    ["aiff", bytes("FORM", 0, 0, 0, 0, "AIFF"), "audio/aiff"],
    ["aifc", bytes("FORM", 0, 0, 0, 0, "AIFC"), "audio/aiff"],
    ["flac", bytes("fLaC", 0), "audio/flac"],
    ["ogg", bytes("OggS", 0), "audio/ogg"],
    ["mp3 sync fb", bytes(0xff, 0xfb, 0x90, 0x00), "audio/mp3"],
    ["mp3 sync f3", bytes(0xff, 0xf3, 0x90, 0x00), "audio/mp3"],
    ["mp3 sync f2", bytes(0xff, 0xf2, 0x90, 0x00), "audio/mp3"],
    ["mp3 sync fa", bytes(0xff, 0xfa, 0x90, 0x00), "audio/mp3"],
    ["short buffer", bytes(0x52), "audio/mp3"],
    ["unknown", bytes(1, 2, 3, 4), "audio/mp3"],
  ];
  for (const [name, data, expected] of cases) {
    assertEquals(detectAudioMimeType(data), expected, name);
  }
});
