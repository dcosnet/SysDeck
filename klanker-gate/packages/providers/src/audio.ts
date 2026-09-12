/**
 * Pure audio byte helpers shared by provider adapters (no I/O).
 *
 * `pcmToWav` wraps raw PCM samples in a RIFF/WAVE container using the exact
 * 44-byte header layout the Go reference emitted (little-endian throughout),
 * so golden-byte tests can pin the output. Gemini TTS returns raw signed
 * 16-bit little-endian PCM at 24 kHz mono, captured by `DEFAULT_GEMINI_PCM`.
 */

export interface PcmConfig {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export const DEFAULT_GEMINI_PCM: PcmConfig = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
};

export function pcmToWav(
  pcm: Uint8Array,
  cfg: PcmConfig = DEFAULT_GEMINI_PCM,
): Uint8Array {
  const { sampleRate, channels, bitsPerSample } = cfg;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      out[offset + i] = text.charCodeAt(i);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/**
 * Sniff an audio MIME type from magic bytes. Check order matters: AAC's ADTS
 * frame sync overlaps MP3's, so AAC is tested first; anything unrecognized
 * falls back to `audio/mp3` (Go parity).
 */
export function detectAudioMimeType(bytes: Uint8Array): string {
  if (bytes.length < 4) return "audio/mp3";
  const tag = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  };
  if (tag(0, "RIFF") && bytes.length >= 12 && tag(8, "WAVE")) {
    return "audio/wav";
  }
  if (tag(0, "ID3")) return "audio/mp3";
  // ADIF, or an ADTS frame sync (0xFFF with layer bits 00) => AAC. Must be
  // checked before the MP3 frame sync, which shares the leading 0xFF.
  if (
    tag(0, "ADIF") ||
    (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0)
  ) {
    return "audio/aac";
  }
  if (
    tag(0, "FORM") && bytes.length >= 12 && (tag(8, "AIFF") || tag(8, "AIFC"))
  ) {
    return "audio/aiff";
  }
  if (tag(0, "fLaC")) return "audio/flac";
  if (tag(0, "OggS")) return "audio/ogg";
  if (
    bytes[0] === 0xff &&
    (bytes[1] === 0xfb || bytes[1] === 0xf3 || bytes[1] === 0xf2 ||
      bytes[1] === 0xfa)
  ) {
    return "audio/mp3";
  }
  return "audio/mp3";
}
