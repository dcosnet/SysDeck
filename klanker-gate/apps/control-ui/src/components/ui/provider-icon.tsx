import {
  Anchor,
  Blocks,
  Bot,
  Boxes,
  Brain,
  Cloud,
  Cpu,
  Gem,
  type LucideIcon,
  Search,
  Server,
  Sparkles,
  Waypoints,
  Wind,
  Zap,
} from "lucide-react";
import { Badge } from "./badge";
import { providerLogo } from "./provider-logos";
import { cn } from "../../lib/utils";

/**
 * Neutral lucide fallback glyph per provider family. The primary icon is now a
 * full-color brand logo (provider-logos.tsx, owner-directed); these glyphs are
 * only used when no brand logo matches (e.g. a generic *-compatible endpoint
 * with no recognizable vendor). Unknown providers fall back to an initials
 * avatar. Kept de-collided where practical.
 */
const PROVIDER_GLYPHS: Record<string, LucideIcon> = {
  openai: Sparkles,
  anthropic: Brain,
  azure: Cloud,
  gemini: Gem,
  vertex: Cloud,
  bedrock: Boxes,
  openrouter: Waypoints,
  groq: Zap,
  cerebras: Cpu,
  mistral: Wind,
  perplexity: Search,
  cohere: Boxes,
  xai: Bot,
  huggingface: Bot,
  parasail: Anchor,
  nebius: Cloud,
  elevenlabs: Zap,
  ollama: Server,
  lmstudio: Server,
  sgl: Server,
};

/** Generic glyph for custom / bring-your-own providers. */
const CUSTOM_GLYPH: LucideIcon = Blocks;

const SIZE: Record<"sm" | "md", string> = {
  sm: "size-6 [&_svg]:size-3.5 text-2xs",
  md: "size-8 [&_svg]:size-4 text-xs",
};

export interface ProviderIconProps {
  /** Provider type or id, e.g. "openai", "anthropic-compatible". */
  provider: string;
  /**
   * Explicit brand key (from a preset) used to pick the logo when `provider`
   * is a generic wire type like "openai-compatible" (e.g. a Z.ai account).
   */
  logoKey?: string;
  /** Display name for the accessible label + initials fallback. */
  name?: string;
  /** Force the generic custom-provider glyph when no brand logo matches. */
  custom?: boolean;
  size?: "sm" | "md";
  className?: string;
}

/** Resolve a provider key to its glyph, tolerating "-compatible" suffixes. */
export function providerGlyph(provider: string): LucideIcon | null {
  const key = provider.trim().toLowerCase();
  return PROVIDER_GLYPHS[key] ??
    PROVIDER_GLYPHS[key.replace(/-compatible$/, "")] ?? null;
}

/** Up-to-two-character initials from a display name. */
export function initialsFrom(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Provider identity tile. Resolution order: full-color brand logo (by explicit
 * logoKey, else by provider type/id) -> neutral lucide glyph -> initials avatar.
 * A matched brand logo renders on a plain tile (no muted fill/border) so the
 * mark reads cleanly; glyph/initials keep the bordered muted tile.
 */
export function ProviderIcon(
  {
    provider,
    logoKey,
    name,
    custom = false,
    size = "md",
    className,
  }: ProviderIconProps,
) {
  const label = name ?? provider;
  const BrandLogo = (logoKey ? providerLogo(logoKey) : null) ??
    providerLogo(provider);
  if (BrandLogo) {
    return (
      <span
        role="img"
        aria-label={label}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-sm",
          SIZE[size],
          className,
        )}
      >
        <BrandLogo />
      </span>
    );
  }
  const Glyph = custom ? CUSTOM_GLYPH : providerGlyph(provider);
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm border",
        "border-border bg-muted font-medium text-muted-foreground",
        SIZE[size],
        className,
      )}
    >
      {Glyph
        ? <Glyph aria-hidden="true" />
        : <span aria-hidden="true">{initialsFrom(label)}</span>}
    </span>
  );
}

export interface AvatarProps {
  name: string;
  size?: "sm" | "md";
  className?: string;
}

/** Neutral initials avatar (customers, teams, users). */
export function Avatar({ name, size = "md", className }: AvatarProps) {
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border",
        "border-border bg-muted font-medium text-muted-foreground",
        SIZE[size],
        className,
      )}
    >
      <span aria-hidden="true">{initialsFrom(name)}</span>
    </span>
  );
}

/** "CUSTOM" chip shown beside bring-your-own providers (spec provider list). */
export function CustomBadge({ className }: { className?: string }) {
  return (
    <Badge
      tone="muted"
      className={cn("uppercase tracking-wide text-2xs", className)}
    >
      Custom
    </Badge>
  );
}
