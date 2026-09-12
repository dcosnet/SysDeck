import { useEffect, useMemo, useState } from "react";
import type { SettingsSection } from "../../api";
import {
  asNumStr,
  NumberCard,
  numOrUndef,
  PanelFooter,
  PanelIntro,
  sourceOf,
} from "./helpers";

interface PerfForm {
  initialPoolSize: string;
  maxRequestBodySizeMb: string;
}

function seed(values: Record<string, unknown> | undefined): PerfForm {
  const v = values ?? {};
  return {
    initialPoolSize: asNumStr(v.initialPoolSize),
    maxRequestBodySizeMb: asNumStr(v.maxRequestBodySizeMb),
  };
}

export interface PerformancePanelProps {
  section: SettingsSection | undefined;
  busy: boolean;
  onSave: (values: Record<string, unknown>) => void;
}

export function PerformancePanel(
  { section, busy, onSave }: PerformancePanelProps,
) {
  const initial = useMemo(() => seed(section?.values), [section]);
  const [form, setForm] = useState<PerfForm>(initial);
  useEffect(() => setForm(initial), [initial]);

  const sources = section?.sources;

  const set = <K extends keyof PerfForm>(key: K, value: PerfForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const changed = useMemo(() => {
    const out: Record<string, unknown> = {};
    const pool = numOrUndef(form.initialPoolSize);
    if (pool !== undefined && pool !== numOrUndef(initial.initialPoolSize)) {
      out.initialPoolSize = pool;
    }
    const body = numOrUndef(form.maxRequestBodySizeMb);
    if (
      body !== undefined && body !== numOrUndef(initial.maxRequestBodySizeMb)
    ) {
      out.maxRequestBodySizeMb = body;
    }
    return out;
  }, [form, initial]);

  const dirty = Object.keys(changed).length > 0;

  return (
    <div className="flex flex-col gap-5">
      <PanelIntro>
        Tune connection pooling and request limits.
      </PanelIntro>

      <NumberCard
        id="perf-pool-size"
        label="Initial Pool Size"
        description="The initial connection pool size."
        min={0}
        value={form.initialPoolSize}
        onChange={(v) => set("initialPoolSize", v)}
        source={sourceOf(sources, "initialPoolSize")}
      />
      <NumberCard
        id="perf-max-body"
        label="Max Request Body Size (MB)"
        description="Maximum size of a request body in megabytes."
        min={1}
        value={form.maxRequestBodySizeMb}
        onChange={(v) => set("maxRequestBodySizeMb", v)}
        source={sourceOf(sources, "maxRequestBodySizeMb")}
      />

      <PanelFooter dirty={dirty} busy={busy} onSave={() => onSave(changed)} />
    </div>
  );
}
