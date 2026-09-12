import { useEffect, useMemo, useState } from "react";
import type { SettingsSection } from "../../api";
import {
  asBool,
  PanelFooter,
  PanelIntro,
  sourceOf,
  ToggleRow,
} from "./helpers";

interface CompatForm {
  convertTextToChat: boolean;
  convertChatToResponses: boolean;
  dropUnsupportedParams: boolean;
  convertUnsupportedParameterValues: boolean;
}

const FIELDS: Array<
  { key: keyof CompatForm; id: string; label: string; description: string }
> = [
  {
    key: "convertTextToChat",
    id: "compat-text-to-chat",
    label: "Convert Text to Chat",
    description:
      "Convert text completion requests to chat for models that only support chat.",
  },
  {
    key: "convertChatToResponses",
    id: "compat-chat-to-responses",
    label: "Convert Chat to Responses",
    description:
      "Convert chat completion requests to responses for models that only support responses.",
  },
  {
    key: "dropUnsupportedParams",
    id: "compat-drop-params",
    label: "Drop Unsupported Params",
    description:
      "Drop unsupported parameters based on the model catalog allowlist.",
  },
  {
    key: "convertUnsupportedParameterValues",
    id: "compat-convert-values",
    label: "Convert Unsupported Parameter Values",
    description:
      "Convert model parameter values that are not supported by the model.",
  },
];

function seed(values: Record<string, unknown> | undefined): CompatForm {
  const v = values ?? {};
  return {
    convertTextToChat: asBool(v.convertTextToChat),
    convertChatToResponses: asBool(v.convertChatToResponses),
    dropUnsupportedParams: asBool(v.dropUnsupportedParams),
    convertUnsupportedParameterValues: asBool(
      v.convertUnsupportedParameterValues,
    ),
  };
}

export interface CompatibilityPanelProps {
  section: SettingsSection | undefined;
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
}

export function CompatibilityPanel(
  { section, busy, onSave }: CompatibilityPanelProps,
) {
  const initial = useMemo(() => seed(section?.values), [section]);
  const [form, setForm] = useState<CompatForm>(initial);
  useEffect(() => setForm(initial), [initial]);

  const sources = section?.sources;

  const changed = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const { key } of FIELDS) {
      if (form[key] !== initial[key]) {
        out[key] = form[key];
      }
    }
    return out;
  }, [form, initial]);

  const dirty = Object.keys(changed).length > 0;

  return (
    <div className="flex flex-col gap-5">
      <PanelIntro>
        Configure request conversions and compatibility fallbacks.
      </PanelIntro>

      <div className="flex flex-col divide-y divide-border">
        {FIELDS.map((field) => (
          <div key={field.key} className="py-3 first:pt-0">
            <ToggleRow
              id={field.id}
              label={field.label}
              description={field.description}
              checked={form[field.key]}
              onCheckedChange={(v) =>
                setForm((prev) => ({ ...prev, [field.key]: v }))}
              source={sourceOf(sources, field.key)}
            />
          </div>
        ))}
      </div>

      <PanelFooter dirty={dirty} busy={busy} onSave={() => onSave(changed)} />
    </div>
  );
}
