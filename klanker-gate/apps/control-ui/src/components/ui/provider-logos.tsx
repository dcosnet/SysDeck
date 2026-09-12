export type LogoProps = { className?: string; title?: string };

interface SvgProps {
  viewBox?: string;
  className?: string;
  title?: string;
  children: React.ReactNode;
}

/**
 * Shared inline-SVG shell. Renders exactly the contract each logo needs:
 * `role="img"`, `aria-hidden` when there is no title, and the caller's
 * `className` for sizing. A `<title>` is emitted only when `title` is passed.
 */
function Svg({ viewBox = "0 0 24 24", className, title, children }: SvgProps) {
  return (
    <svg
      viewBox={viewBox}
      role="img"
      aria-hidden={title ? undefined : true}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

interface ChipProps {
  className?: string;
  title?: string;
  children: React.ReactNode;
}

/**
 * Subtle light rounded chip behind near-black / near-white marks so they stay
 * legible on BOTH light and dark surfaces (the app default is dark, where a raw
 * black mark would vanish).
 */
function ChipSvg({ className, title, children }: ChipProps) {
  return (
    <Svg className={className} title={title}>
      <rect
        x="1"
        y="1"
        width="22"
        height="22"
        rx="6"
        fill="#f4f4f5"
        stroke="#d4d4d8"
        strokeWidth="0.5"
      />
      {children}
    </Svg>
  );
}

interface MonogramProps {
  text: string;
  fg: string;
  bg: string;
  className?: string;
  title?: string;
}

/** Brand-colored rounded-rect chip carrying a short wordmark / initial(s). */
function Monogram({ text, fg, bg, className, title }: MonogramProps) {
  const fontSize = text.length >= 4 ? 6.5 : text.length === 3 ? 8 : 11;
  return (
    <Svg className={className} title={title}>
      <rect x="1" y="1" width="22" height="22" rx="6" fill={bg} />
      <text
        x="12"
        y="12.4"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif"
        fontSize={fontSize}
        fontWeight="700"
        fill={fg}
      >
        {text}
      </text>
    </Svg>
  );
}

// --- Individual brand marks ------------------------------------------------

/** OpenAI - near-black six-petal blossom on a light chip. */
export function OpenAILogo({ className, title }: LogoProps) {
  return (
    <ChipSvg className={className} title={title}>
      <g fill="#0d0d0d">
        <rect x="10.7" y="4.5" width="2.6" height="15" rx="1.3" />
        <rect
          x="10.7"
          y="4.5"
          width="2.6"
          height="15"
          rx="1.3"
          transform="rotate(60 12 12)"
        />
        <rect
          x="10.7"
          y="4.5"
          width="2.6"
          height="15"
          rx="1.3"
          transform="rotate(120 12 12)"
        />
      </g>
    </ChipSvg>
  );
}

/** Anthropic - near-black splayed "A" on a light chip. */
export function AnthropicLogo({ className, title }: LogoProps) {
  return (
    <ChipSvg className={className} title={title}>
      <path
        fill="#141413"
        fillRule="evenodd"
        d="M10.4 5h3.2l4.9 14h-3.3l-1.1-3.3H9.9L8.8 19H5.5L10.4 5Zm1.6 3.6L10.6 13h2.8L12 8.6Z"
      />
    </ChipSvg>
  );
}

/** Azure OpenAI - twin blue-gradient triangles. */
export function AzureLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <defs>
        <linearGradient id="fg-azure" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3ccbf4" />
          <stop offset="1" stopColor="#0a5bd3" />
        </linearGradient>
      </defs>
      <path d="M12.4 4.5 20.6 20H4.2Z" fill="url(#fg-azure)" opacity="0.45" />
      <path d="M15 8 20.6 20H9.5Z" fill="url(#fg-azure)" />
    </Svg>
  );
}

/** Google Gemini - blue→purple→pink four-point sparkle. */
export function GeminiLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <defs>
        <linearGradient id="fg-gemini" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4796e3" />
          <stop offset="0.5" stopColor="#9177c7" />
          <stop offset="1" stopColor="#d56590" />
        </linearGradient>
      </defs>
      <path
        d="M12 2c.4 5.2 4.8 9.6 10 10-5.2.4-9.6 4.8-10 10-.4-5.2-4.8-9.6-10-10 5.2-.4 9.6-4.8 10-10Z"
        fill="url(#fg-gemini)"
      />
    </Svg>
  );
}

/** Google Vertex - four Google-color quadrants forming a diamond. */
export function VertexLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <path d="M12 3 21 12H12Z" fill="#4285f4" />
      <path d="M21 12 12 21V12Z" fill="#ea4335" />
      <path d="M12 21 3 12h9Z" fill="#fbbc05" />
      <path d="M3 12 12 3v9Z" fill="#34a853" />
    </Svg>
  );
}

/** AWS Bedrock - stacked strata in AWS oranges. */
export function BedrockLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <rect x="4" y="6" width="16" height="3.2" rx="1.2" fill="#c45500" />
      <rect x="4" y="10.4" width="16" height="3.2" rx="1.2" fill="#ec7211" />
      <rect x="4" y="14.8" width="16" height="3.2" rx="1.2" fill="#ff9900" />
    </Svg>
  );
}

/** OpenRouter - two source nodes routing to one, in indigo. */
export function OpenRouterLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <g fill="none" stroke="#6366f1" strokeWidth="1.7" strokeLinecap="round">
        <path d="M7.5 7.5C13 7.5 11 16.5 16.5 16.5" />
        <path d="M7.5 16.5h9" />
      </g>
      <g fill="#6366f1">
        <circle cx="6.5" cy="7.5" r="2.2" />
        <circle cx="6.5" cy="16.5" r="2.2" />
        <circle cx="17.5" cy="16.5" r="2.2" />
      </g>
    </Svg>
  );
}

/** Groq - orange wordmark chip. */
export function GroqLogo({ className, title }: LogoProps) {
  return (
    <Monogram
      text="groq"
      fg="#ffffff"
      bg="#f55036"
      className={className}
      title={title}
    />
  );
}

/** Mistral - the colorful yellow→red striped square. */
export function MistralLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <rect x="4" y="5" width="16" height="2.8" fill="#ffd21e" />
      <rect x="4" y="7.8" width="16" height="2.8" fill="#ff9a00" />
      <rect x="4" y="10.6" width="16" height="2.8" fill="#ff7a00" />
      <rect x="4" y="13.4" width="16" height="2.8" fill="#f7501e" />
      <rect x="4" y="16.2" width="16" height="2.8" fill="#e10500" />
    </Svg>
  );
}

/** Perplexity - teal split-orb mark. */
export function PerplexityLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <g fill="none" stroke="#20b8cd" strokeWidth="2" strokeLinecap="round">
        <path d="M12 4v16" />
        <path d="M12 6c-5 0-7 3-7 6s2 6 7 6" />
        <path d="M12 6c5 0 7 3 7 6s-2 6-7 6" />
      </g>
    </Svg>
  );
}

/** Cerebras - orange wafer mesh (3×3 dot grid). */
export function CerebrasLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <g fill="#f04e23">
        <circle cx="7.5" cy="7.5" r="1.8" />
        <circle cx="12" cy="7.5" r="1.8" />
        <circle cx="16.5" cy="7.5" r="1.8" />
        <circle cx="7.5" cy="12" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="16.5" cy="12" r="1.8" />
        <circle cx="7.5" cy="16.5" r="1.8" />
        <circle cx="12" cy="16.5" r="1.8" />
        <circle cx="16.5" cy="16.5" r="1.8" />
      </g>
    </Svg>
  );
}

/** xAI - near-black "X" on a light chip. */
export function XaiLogo({ className, title }: LogoProps) {
  return (
    <ChipSvg className={className} title={title}>
      <path
        d="M6.5 6 17.5 18M17.5 6 6.5 18"
        stroke="#0f0f0f"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </ChipSvg>
  );
}

/** Hugging Face - the yellow hugging-face emoji. */
export function HuggingFaceLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <circle cx="4.8" cy="13.6" r="1.9" fill="#ff9d0b" />
      <circle cx="19.2" cy="13.6" r="1.9" fill="#ff9d0b" />
      <circle cx="12" cy="12" r="8" fill="#ffd21e" />
      <circle cx="9.2" cy="11" r="1.1" fill="#3a3a3a" />
      <circle cx="14.8" cy="11" r="1.1" fill="#3a3a3a" />
      <path
        d="M8.8 13.9c1.6 2 5.2 2 6.8 0"
        fill="none"
        stroke="#3a3a3a"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Cohere - coral wordmark chip. */
export function CohereLogo({ className, title }: LogoProps) {
  return (
    <Monogram
      text="co"
      fg="#ffffff"
      bg="#ff7759"
      className={className}
      title={title}
    />
  );
}

/** ElevenLabs - the twin-bar "11" on a light chip. */
export function ElevenLabsLogo({ className, title }: LogoProps) {
  return (
    <ChipSvg className={className} title={title}>
      <rect x="8.4" y="6" width="2.6" height="12" rx="1.3" fill="#0f0f0f" />
      <rect x="13" y="6" width="2.6" height="12" rx="1.3" fill="#0f0f0f" />
    </ChipSvg>
  );
}

/** Ollama - the friendly llama, near-black on a light chip. */
export function OllamaLogo({ className, title }: LogoProps) {
  return (
    <ChipSvg className={className} title={title}>
      <g fill="#0f0f0f">
        <ellipse
          cx="9.5"
          cy="6.6"
          rx="1.4"
          ry="2.4"
          transform="rotate(-12 9.5 6.6)"
        />
        <ellipse
          cx="14.5"
          cy="6.6"
          rx="1.4"
          ry="2.4"
          transform="rotate(12 14.5 6.6)"
        />
        <path d="M8 10c0-1.7 8-1.7 8 0v4c0 2-2 4-4 4s-4-2-4-4Z" />
      </g>
      <circle cx="10.4" cy="12" r="0.95" fill="#f4f4f5" />
      <circle cx="13.6" cy="12" r="0.95" fill="#f4f4f5" />
    </ChipSvg>
  );
}

/** LM Studio - violet wordmark chip. */
export function LmStudioLogo({ className, title }: LogoProps) {
  return (
    <Monogram
      text="LM"
      fg="#ffffff"
      bg="#7c3aed"
      className={className}
      title={title}
    />
  );
}

/** Nebius - green monogram chip. */
export function NebiusLogo({ className, title }: LogoProps) {
  return (
    <Monogram
      text="N"
      fg="#ffffff"
      bg="#00a87e"
      className={className}
      title={title}
    />
  );
}

/** SGLang - violet wordmark chip. */
export function SglLogo({ className, title }: LogoProps) {
  return (
    <Monogram
      text="SGL"
      fg="#ffffff"
      bg="#6d28d9"
      className={className}
      title={title}
    />
  );
}

/** Parasail - a blue two-tone sail over a wave. */
export function ParasailLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <path d="M12 4 6 16.5h6Z" fill="#5aa9f0" />
      <path d="M12 4l6 12.5h-6Z" fill="#2f7fe0" />
      <rect x="11.4" y="4" width="1.2" height="13" fill="#1e4e8c" />
      <path
        d="M5 18.5c3 1.6 11 1.6 14 0"
        fill="none"
        stroke="#2f7fe0"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Z.ai - blue monogram chip. */
export function ZaiLogo({ className, title }: LogoProps) {
  return (
    <Monogram
      text="Z"
      fg="#ffffff"
      bg="#2f6bff"
      className={className}
      title={title}
    />
  );
}

/** MiniMax - red monogram chip. */
export function MiniMaxLogo({ className, title }: LogoProps) {
  return (
    <Monogram
      text="M"
      fg="#ffffff"
      bg="#f23f2c"
      className={className}
      title={title}
    />
  );
}

/** Moonshot / Kimi - a near-black crescent moon on a light chip. */
export function MoonshotLogo({ className, title }: LogoProps) {
  return (
    <ChipSvg className={className} title={title}>
      <circle cx="12" cy="12" r="7.5" fill="#141413" />
      <circle cx="14.6" cy="10.4" r="6.2" fill="#f4f4f5" />
      <circle cx="15.6" cy="16" r="0.9" fill="#141413" />
    </ChipSvg>
  );
}

/** vLLM - sky-blue wordmark chip. */
export function VllmLogo({ className, title }: LogoProps) {
  return (
    <Monogram
      text="vLLM"
      fg="#ffffff"
      bg="#0ea5e9"
      className={className}
      title={title}
    />
  );
}

/** DeepSeek - a blue orb with a white dive-wave. */
export function DeepSeekLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <circle cx="12" cy="12" r="8" fill="#4d6bfe" />
      <path
        d="M7 13c2 2 5 2 6.5 0 1-1.4 2.5-1.5 3.5-.5"
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Together AI - three overlapping indigo orbs. */
export function TogetherLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <g fillOpacity="0.85">
        <circle cx="9.5" cy="10" r="4.6" fill="#6366f1" />
        <circle cx="14.5" cy="10" r="4.6" fill="#818cf8" />
        <circle cx="12" cy="15" r="4.6" fill="#4f46e5" />
      </g>
    </Svg>
  );
}

/** Fireworks AI - a magenta→purple gradient burst. */
export function FireworksLogo({ className, title }: LogoProps) {
  return (
    <Svg className={className} title={title}>
      <defs>
        <linearGradient id="fg-fireworks" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <g
        stroke="url(#fg-fireworks)"
        strokeWidth="1.7"
        strokeLinecap="round"
      >
        <path d="M12 12 20 12" />
        <path d="M12 12 17.7 6.3" />
        <path d="M12 12 12 4" />
        <path d="M12 12 6.3 6.3" />
        <path d="M12 12 4 12" />
        <path d="M12 12 6.3 17.7" />
        <path d="M12 12 12 20" />
        <path d="M12 12 17.7 17.7" />
      </g>
      <circle cx="12" cy="12" r="1.9" fill="url(#fg-fireworks)" />
    </Svg>
  );
}

/** DeepInfra - blue monogram chip. */
export function DeepInfraLogo({ className, title }: LogoProps) {
  return (
    <Monogram
      text="DI"
      fg="#ffffff"
      bg="#2563eb"
      className={className}
      title={title}
    />
  );
}

// --- Resolver --------------------------------------------------------------

/** Canonical brand key → mark. Insertion order defines `PROVIDER_LOGO_KEYS`. */
const LOGOS: Record<string, React.FC<LogoProps>> = {
  openai: OpenAILogo,
  anthropic: AnthropicLogo,
  azure: AzureLogo,
  gemini: GeminiLogo,
  vertex: VertexLogo,
  bedrock: BedrockLogo,
  openrouter: OpenRouterLogo,
  groq: GroqLogo,
  mistral: MistralLogo,
  perplexity: PerplexityLogo,
  cerebras: CerebrasLogo,
  xai: XaiLogo,
  huggingface: HuggingFaceLogo,
  cohere: CohereLogo,
  elevenlabs: ElevenLabsLogo,
  ollama: OllamaLogo,
  lmstudio: LmStudioLogo,
  nebius: NebiusLogo,
  sgl: SglLogo,
  parasail: ParasailLogo,
  zai: ZaiLogo,
  minimax: MiniMaxLogo,
  moonshot: MoonshotLogo,
  vllm: VllmLogo,
  deepseek: DeepSeekLogo,
  together: TogetherLogo,
  fireworks: FireworksLogo,
  deepinfra: DeepInfraLogo,
};

/** Non-canonical spellings that map onto a covered brand key. */
const ALIASES: Record<string, string> = {
  google: "gemini",
  "google-vertex": "vertex",
  "vertex-ai": "vertex",
  aws: "bedrock",
  "aws-bedrock": "bedrock",
  "amazon-bedrock": "bedrock",
  "x-ai": "xai",
  grok: "xai",
  mistralai: "mistral",
  hf: "huggingface",
  "hugging-face": "huggingface",
  "perplexity-ai": "perplexity",
  kimi: "moonshot",
  moonshotai: "moonshot",
  "z-ai": "zai",
  zhipu: "zai",
  glm: "zai",
  minimaxi: "minimax",
  "together-ai": "together",
  "fireworks-ai": "fireworks",
  "deep-seek": "deepseek",
};

/**
 * Resolve a provider `type`/id to its brand mark, or `null` when there is no
 * single brand behind it (e.g. the generic `*-compatible` bring-your-own wire
 * types) so callers can fall back to the neutral glyph / initials avatar.
 */
export function providerLogo(key: string): React.FC<LogoProps> | null {
  const k = key.trim().toLowerCase();
  if (k.endsWith("-compatible")) {
    return null;
  }
  const canonical = ALIASES[k] ?? k;
  return LOGOS[canonical] ?? null;
}

/** Every brand key with a dedicated mark (for tests / coverage checks). */
export const PROVIDER_LOGO_KEYS: string[] = Object.keys(LOGOS);
