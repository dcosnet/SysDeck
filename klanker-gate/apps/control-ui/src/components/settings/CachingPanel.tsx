import { useEffect, useMemo, useState } from "react";
import {
  getConfig,
  type ProviderAccountPublic,
  type SettingsSection,
} from "../../api";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Combobox, type ComboboxOption } from "../ui/combobox";
import {
  asBool,
  asNumStr,
  asString,
  FieldBlock,
  numOrUndef,
  PanelFooter,
  PanelIntro,
  SectionTitle,
  sourceOf,
  ToggleRow,
} from "./helpers";
import { CacheOpsPanel } from "./CacheOpsPanel";

interface CachingForm {
  enabled: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  ttlSeconds: string;
  similarityThreshold: string;
  dimension: string;
  conversationHistoryThreshold: string;
  excludeSystemPrompt: boolean;
  cacheByModel: boolean;
  cacheByProvider: boolean;
}

function seed(values: Record<string, unknown> | undefined): CachingForm {
  const v = values ?? {};
  return {
    enabled: asBool(v.enabled),
    embeddingProvider: asString(v.embeddingProvider),
    embeddingModel: asString(v.embeddingModel),
    ttlSeconds: asNumStr(v.ttlSeconds),
    similarityThreshold: asNumStr(v.similarityThreshold),
    dimension: asNumStr(v.dimension),
    conversationHistoryThreshold: asNumStr(v.conversationHistoryThreshold),
    excludeSystemPrompt: asBool(v.excludeSystemPrompt),
    cacheByModel: asBool(v.cacheByModel),
    cacheByProvider: asBool(v.cacheByProvider),
  };
}

/** Diff a numeric field; only emit a real numeric change (never undefined). */
function numChange(
  out: Record<string, unknown>,
  key: string,
  next: string,
  prev: string,
) {
  const parsed = numOrUndef(next);
  if (parsed !== undefined && parsed !== numOrUndef(prev)) {
    out[key] = parsed;
  }
}

export interface CachingPanelProps {
  section: SettingsSection | undefined;
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
}

export function CachingPanel({ section, busy, onSave }: CachingPanelProps) {
  const initial = useMemo(() => seed(section?.values), [section]);
  const [form, setForm] = useState<CachingForm>(initial);
  useEffect(() => setForm(initial), [initial]);

  const sources = section?.sources;

  const [providers, setProviders] = useState<ProviderAccountPublic[]>([]);
  useEffect(() => {
    let alive = true;
    getConfig()
      .then((cfg) => {
        if (alive) setProviders(cfg.providers);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const set = <K extends keyof CachingForm>(key: K, value: CachingForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const providerOptions = useMemo<ComboboxOption[]>(() => {
    const values = new Set<string>();
    for (const p of providers) {
      if (p.enabled) values.add(p.id);
    }
    // The stored value always shows, even if that provider was since removed.
    if (form.embeddingProvider) {
      values.add(form.embeddingProvider);
    }
    return [...values].map((value) => ({ value, label: value }));
  }, [providers, form.embeddingProvider]);

  const changed = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (form.enabled !== initial.enabled) {
      out.enabled = form.enabled;
    }
    if (form.embeddingProvider !== initial.embeddingProvider) {
      out.embeddingProvider = form.embeddingProvider;
    }
    if (form.embeddingModel.trim() !== initial.embeddingModel) {
      out.embeddingModel = form.embeddingModel.trim();
    }
    numChange(out, "ttlSeconds", form.ttlSeconds, initial.ttlSeconds);
    numChange(
      out,
      "similarityThreshold",
      form.similarityThreshold,
      initial.similarityThreshold,
    );
    numChange(out, "dimension", form.dimension, initial.dimension);
    numChange(
      out,
      "conversationHistoryThreshold",
      form.conversationHistoryThreshold,
      initial.conversationHistoryThreshold,
    );
    if (form.excludeSystemPrompt !== initial.excludeSystemPrompt) {
      out.excludeSystemPrompt = form.excludeSystemPrompt;
    }
    if (form.cacheByModel !== initial.cacheByModel) {
      out.cacheByModel = form.cacheByModel;
    }
    if (form.cacheByProvider !== initial.cacheByProvider) {
      out.cacheByProvider = form.cacheByProvider;
    }
    return out;
  }, [form, initial]);

  const dirty = Object.keys(changed).length > 0;

  return (
    <div className="flex flex-col gap-5">
      <PanelIntro>
        Configure semantic caching for inference requests.
      </PanelIntro>

      <Card>
        <CardContent className="flex flex-col gap-6">
          <ToggleRow
            id="cache-enabled"
            label="Enable Semantic Caching"
            description={
              <>
                Enable semantic caching for requests. Send the{" "}
                <code className="font-mono">x-frosty-cache-key</code>{" "}
                header with requests to use semantic caching.
              </>
            }
            checked={form.enabled}
            onCheckedChange={(v) => set("enabled", v)}
            source={sourceOf(sources, "enabled")}
          />

          <div className="h-px bg-border" />

          <div className="flex flex-col gap-3">
            <SectionTitle>Provider and model</SectionTitle>
            <div className="field-grid">
              <FieldBlock
                id="cache-embed-provider"
                label="Embedding Provider"
                source={sourceOf(sources, "embeddingProvider")}
              >
                <Combobox
                  id="cache-embed-provider"
                  label="Embedding Provider"
                  options={providerOptions}
                  value={form.embeddingProvider || null}
                  onChange={(v) => set("embeddingProvider", v)}
                  placeholder="Select a provider"
                />
              </FieldBlock>
              <FieldBlock
                id="cache-embed-model"
                label="Embedding Model"
                required
                source={sourceOf(sources, "embeddingModel")}
              >
                <Input
                  id="cache-embed-model"
                  value={form.embeddingModel}
                  onChange={(e) => set("embeddingModel", e.target.value)}
                  placeholder="text-embedding-3-large"
                />
              </FieldBlock>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <SectionTitle>Cache parameters</SectionTitle>
            <div className="field-grid">
              <FieldBlock
                id="cache-ttl"
                label="TTL (seconds)"
                source={sourceOf(sources, "ttlSeconds")}
              >
                <Input
                  id="cache-ttl"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={form.ttlSeconds}
                  onChange={(e) => set("ttlSeconds", e.target.value)}
                  placeholder="300"
                />
              </FieldBlock>
              <FieldBlock
                id="cache-threshold"
                label="Similarity Threshold"
                source={sourceOf(sources, "similarityThreshold")}
              >
                <Input
                  id="cache-threshold"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={1}
                  step={0.01}
                  value={form.similarityThreshold}
                  onChange={(e) => set("similarityThreshold", e.target.value)}
                  placeholder="0.85"
                />
              </FieldBlock>
            </div>
            <FieldBlock
              id="cache-dimension"
              label="Dimension"
              source={sourceOf(sources, "dimension")}
            >
              <Input
                id="cache-dimension"
                type="number"
                inputMode="numeric"
                min={1}
                value={form.dimension}
                onChange={(e) => set("dimension", e.target.value)}
                placeholder="1536"
              />
            </FieldBlock>
            <p className="text-sm text-muted-foreground">
              API keys for the embedding provider are inherited from the main
              provider configuration. The semantic cache uses the configured
              provider's keys automatically.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <SectionTitle>Conversation</SectionTitle>
            <FieldBlock
              id="cache-history-threshold"
              label="Conversation History Threshold"
              source={sourceOf(sources, "conversationHistoryThreshold")}
              hint="Skip caching for conversations with more than this number of messages (prevents false positives)."
            >
              <Input
                id="cache-history-threshold"
                type="number"
                inputMode="numeric"
                min={0}
                value={form.conversationHistoryThreshold}
                onChange={(e) =>
                  set("conversationHistoryThreshold", e.target.value)}
                placeholder="3"
              />
            </FieldBlock>
            <ToggleRow
              bordered
              id="cache-exclude-system"
              label="Exclude System Prompt"
              description="Exclude system messages from cache key generation."
              checked={form.excludeSystemPrompt}
              onCheckedChange={(v) => set("excludeSystemPrompt", v)}
              source={sourceOf(sources, "excludeSystemPrompt")}
            />
          </div>

          <div className="flex flex-col gap-3">
            <SectionTitle>Cache behavior</SectionTitle>
            <ToggleRow
              bordered
              id="cache-by-model"
              label="Cache by Model"
              description="Include the model name in the cache key."
              checked={form.cacheByModel}
              onCheckedChange={(v) => set("cacheByModel", v)}
              source={sourceOf(sources, "cacheByModel")}
            />
            <ToggleRow
              bordered
              id="cache-by-provider"
              label="Cache by Provider"
              description="Include the provider name in the cache key."
              checked={form.cacheByProvider}
              onCheckedChange={(v) => set("cacheByProvider", v)}
              source={sourceOf(sources, "cacheByProvider")}
            />
          </div>

          <div className="flex flex-col gap-2">
            <SectionTitle>Notes</SectionTitle>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              <CacheNote header="x-frosty-cache-ttl">
                use a request-specific TTL.
              </CacheNote>
              <CacheNote header="x-frosty-cache-threshold">
                use a request-specific similarity threshold.
              </CacheNote>
              <CacheNote header="x-frosty-cache-type">
                pass "direct" or "semantic" to control cache behavior.
              </CacheNote>
              <CacheNote header="x-frosty-cache-no-store">
                pass "true" to disable response caching.
              </CacheNote>
            </ul>
          </div>
        </CardContent>
      </Card>

      <PanelFooter dirty={dirty} busy={busy} onSave={() => onSave(changed)} />

      {
        /* Operations, formerly the standalone "Cache" page. Kept BELOW the save
          footer and behind a divider so a destructive purge is never adjacent
          to the Save button that applies configuration edits. */
      }
      <div className="mt-8 border-t border-border pt-6">
        <h3 className="mb-1 text-lg font-semibold text-foreground">
          Operations
        </h3>
        <p className="mb-4 text-sm text-muted-foreground">
          Invalidate cached completions. These act immediately and are not part
          of the settings save above.
        </p>
        <CacheOpsPanel />
      </div>
    </div>
  );
}

function CacheNote(
  { header, children }: { header: string; children: React.ReactNode },
) {
  return (
    <li className="flex gap-2">
      <span aria-hidden="true" className="text-muted-foreground">
        &bull;
      </span>
      <span>
        Pass the <code className="font-mono text-foreground">{header}</code>
        {" "}
        header to {children}
      </span>
    </li>
  );
}
