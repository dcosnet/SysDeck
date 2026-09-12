import { type FormEvent, useState } from "react";
import { Plus } from "lucide-react";
import type { ProviderAccountConfig } from "../../api";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Field } from "../ui/label";
import { NativeSelect } from "../ui/select";
import { Switch } from "../ui/switch";
import { Banner } from "../ui/banner";
import { ToggleGridItem } from "../ui/toggle-grid-item";
import { CUSTOM_BASE_FORMATS, REQUEST_TYPES } from "./constants";

type ProviderType = ProviderAccountConfig["type"];

export interface AddCustomProviderFormProps {
  busy: boolean;
  onSubmit: (payload: ProviderAccountConfig) => void;
  onCancel: () => void;
}

function defaultRequestTypes(): Record<string, boolean> {
  return Object.fromEntries(REQUEST_TYPES.map((r) => [r.key, true]));
}

/**
 * Inline Add Custom Provider form (spec: Name, Base Format, Base URL, an "Is
 * Keyless" switch, and a two-column Allowed Request Types grid). Rendered in the
 * detail pane like the standard add form rather than a modal. The config
 * contract has no per-endpoint path or request-type storage, so the grid is an
 * advisory capability picker (labelled as such) - create posts only the fields
 * the gateway persists: id, wire type, base URL, and an optional key.
 */
export function AddCustomProviderForm(
  { busy, onSubmit, onCancel }: AddCustomProviderFormProps,
) {
  const [name, setName] = useState("");
  const [format, setFormat] = useState<ProviderType>("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [keyless, setKeyless] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [allowed, setAllowed] = useState<Record<string, boolean>>(
    defaultRequestTypes,
  );
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    const id = name.trim();
    if (id === "") {
      setError("A name is required.");
      return;
    }
    if (baseUrl.trim() === "") {
      setError("A base URL is required for a custom provider.");
      return;
    }
    setError(null);
    const payload: ProviderAccountConfig = {
      id,
      type: format,
      enabled: true,
      models: [],
      priority: 0,
      baseUrl: baseUrl.trim(),
    };
    if (!keyless && apiKey.trim() !== "") {
      payload.apiKey = apiKey.trim();
    }
    onSubmit(payload);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div>
        <h3 className="text-lg font-semibold text-foreground">
          Add custom provider
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Point the gateway at any OpenAI- or Anthropic-compatible endpoint.
          Keys are stored server-side and never shown again.
        </p>
      </div>

      <div className="field-grid">
        <Field id="custom-name" label="Name" required>
          <Input
            id="custom-name"
            value={name}
            placeholder="my-gateway"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field id="custom-format" label="Base Format">
          <NativeSelect
            id="custom-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as ProviderType)}
          >
            {CUSTOM_BASE_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="custom-baseurl" label="Base URL" required>
          <Input
            id="custom-baseurl"
            value={baseUrl}
            placeholder="https://api.your-provider.com"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-card px-4 py-3">
        <label htmlFor="custom-keyless" className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium text-foreground">
            Is Keyless?
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Whether the custom provider requires a key
          </span>
        </label>
        <Switch
          id="custom-keyless"
          checked={keyless}
          onCheckedChange={setKeyless}
          aria-label="Is keyless"
        />
      </div>

      {!keyless && (
        <Field id="custom-key" label="API key (optional)">
          <Input
            id="custom-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder="Add now, or add a key later from the keys table"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </Field>
      )}

      <div className="flex flex-col gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">
            Allowed Request Types
          </p>
          <p className="text-xs text-muted-foreground">
            Advisory capability picker. The gateway routes every request type
            its wire format supports; per-endpoint path overrides are not
            persisted.
          </p>
        </div>
        <div className="field-grid">
          {REQUEST_TYPES.map((rt) => (
            <ToggleGridItem
              key={rt.key}
              id={`rt-${rt.key}`}
              label={rt.label}
              checked={allowed[rt.key] ?? true}
              onCheckedChange={(checked) =>
                setAllowed((prev) => ({ ...prev, [rt.key]: checked }))}
            />
          ))}
        </div>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" isLoading={busy}>
          <Plus aria-hidden="true" />
          Add provider
        </Button>
      </div>
    </form>
  );
}
