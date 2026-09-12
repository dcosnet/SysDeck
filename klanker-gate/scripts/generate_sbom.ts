import { fromFileUrl } from "@std/path";

const docsRoot = new URL("../docs/reference/", import.meta.url);
const sbomJsonPath = new URL("sbom/sbom.cyclonedx.json", docsRoot);
const sbomMdPath = new URL("sbom.md", docsRoot);

type Scope = "required" | "dev" | "optional";
type Directness = "Direct" | "Transitive";

interface ComponentRow {
  bomRef: string;
  type: string;
  name: string;
  version: string;
  ecosystem: string;
  purl: string;
  license: string;
  directness: Directness;
  scope: Scope;
}

interface CycloneComponent {
  "bom-ref": string;
  type: string;
  name: string;
  version: string;
  purl: string;
  licenses?: Array<{ license: { id?: string; name?: string } }>;
}

interface LockLike {
  version: string;
  specifiers: Record<string, string>;
  jsr?: Record<string, { dependencies?: string[] }>;
  npm?: Record<string, { dependencies?: string[] }>;
}

function stripJsonc(input: string): string {
  return input.replace(/(^|\n)\s*\/\/.*(?=\n|$)/g, "$1");
}

function readJson<T>(path: URL): T {
  return JSON.parse(Deno.readTextFileSync(path)) as T;
}

function readJsonc<T>(path: URL): T {
  return JSON.parse(stripJsonc(Deno.readTextFileSync(path))) as T;
}

function extractVersion(): string {
  const source = Deno.readTextFileSync(
    new URL("../apps/gateway/context.ts", import.meta.url),
  );
  const match = source.match(/export const VERSION = "([^"]+)"/);
  if (!match) {
    throw new Error("Could not extract VERSION from apps/gateway/context.ts");
  }
  return match[1];
}

function encodePurlName(name: string): string {
  return name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function licenseBlock(license: string) {
  return license === "Apache-2.0"
    ? [{ license: { id: license } }]
    : [{ license: { name: license } }];
}

function parseNpmKey(key: string): { name: string; version: string } {
  const at = key.startsWith("@")
    ? key.indexOf("@", key.indexOf("/") + 1)
    : key.indexOf("@");
  const name = key.slice(0, at);
  const version = key.slice(at + 1).split("_")[0];
  return { name, version };
}

function parseJsrKey(key: string): { name: string; version: string } {
  const at = key.startsWith("@")
    ? key.indexOf("@", key.indexOf("/") + 1)
    : key.indexOf("@");
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function parseJsrSpecifier(specifier: string): {
  name: string;
  versionSpec?: string;
} {
  const raw = specifier.replace(/^jsr:/, "");
  const at = raw.startsWith("@")
    ? raw.indexOf("@", raw.indexOf("/") + 1)
    : raw.indexOf("@");
  if (at === -1) {
    return { name: raw };
  }
  return { name: raw.slice(0, at), versionSpec: raw.slice(at + 1) };
}

function jsrPurl(name: string, version: string): string {
  return `pkg:jsr/${encodePurlName(name)}@${encodeURIComponent(version)}`;
}

function npmPurl(name: string, version: string): string {
  return `pkg:npm/${encodePurlName(name)}@${encodeURIComponent(version)}`;
}

function dockerPurl(name: string, version: string): string {
  return `pkg:docker/${name}@${encodeURIComponent(version)}`;
}

function candidateNpmKeys(
  index: Map<string, string[]>,
  depName: string,
): string[] {
  return index.get(depName) ?? [];
}

function resolveNpmKey(
  lock: LockLike,
  index: Map<string, string[]>,
  name: string,
  declaredSpec: string,
): string | undefined {
  const resolved = lock.specifiers[`npm:${name}@${declaredSpec}`];
  const candidates = candidateNpmKeys(index, name);
  if (resolved) {
    const exact = candidates.find((key) =>
      parseNpmKey(key).version === resolved
    );
    if (exact) {
      return exact;
    }
  }
  return candidates[0];
}

function resolveJsrKey(
  lock: LockLike,
  keys: string[],
  specifier: string,
): string | undefined {
  const resolved = lock.specifiers[specifier];
  const { name: rawName } = parseJsrSpecifier(specifier);
  if (resolved) {
    const exact = keys.find((key) => {
      const parsed = parseJsrKey(key);
      return parsed.name === rawName && parsed.version === resolved;
    });
    if (exact) {
      return exact;
    }
  }
  return keys.find((key) => parseJsrKey(key).name === rawName);
}

function crawl<T>(
  roots: Iterable<T>,
  next: (node: T) => Iterable<T>,
): Set<T> {
  const seen = new Set<T>();
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const child of next(current)) {
      if (!seen.has(child)) {
        queue.push(child);
      }
    }
  }
  return seen;
}

function escapeMd(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function tableFor(rows: ComponentRow[]): string[] {
  const lines = [
    "| Component | Version | Type | Ecosystem | PURL | License | Direct/Transitive | Scope |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${escapeMd(row.name)} | ${
        escapeMd(row.version)
      } | ${row.type} | ${row.ecosystem} | ${
        escapeMd(row.purl)
      } | ${row.license} | ${row.directness} | ${row.scope} |`,
    );
  }
  return lines;
}

function main() {
  const timestamp = new Date().toISOString();
  const version = extractVersion();
  const lock = readJson<LockLike>(new URL("../deno.lock", import.meta.url));
  const rootJson = readJsonc<{
    imports?: Record<string, string>;
  }>(new URL("../deno.jsonc", import.meta.url));
  const uiPackage = readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(new URL("../apps/control-ui/package.json", import.meta.url));
  const browserPackage = readJson<{
    devDependencies?: Record<string, string>;
  }>(new URL("../tests/browser/package.json", import.meta.url));

  const jsrKeys = Object.keys(lock.jsr ?? {});
  const npmKeys = Object.keys(lock.npm ?? {});

  const npmIndex = new Map<string, string[]>();
  for (const key of npmKeys) {
    const parsed = parseNpmKey(key);
    const bucket = npmIndex.get(parsed.name) ?? [];
    bucket.push(key);
    npmIndex.set(parsed.name, bucket);
  }

  const directRequiredJsr = new Set<string>();
  const directDevJsr = new Set<string>();
  for (const [name, spec] of Object.entries(rootJson.imports ?? {})) {
    if (!spec.startsWith("jsr:")) continue;
    const resolved = resolveJsrKey(lock, jsrKeys, spec);
    if (!resolved) continue;
    if (name === "@std/assert") {
      directDevJsr.add(resolved);
    } else {
      directRequiredJsr.add(resolved);
    }
  }

  const rootRuntimeNpm = ["zod", "postgres"];
  const uiRuntimeNpm = Object.entries(uiPackage.dependencies ?? {});
  const uiDevNpm = Object.entries(uiPackage.devDependencies ?? {});
  const browserDevNpm = Object.entries(browserPackage.devDependencies ?? {});

  const directRequiredNpm = new Set<string>();
  const directDevNpm = new Set<string>();

  for (const name of rootRuntimeNpm) {
    const spec = name === "zod" ? "4" : "3";
    const resolved = resolveNpmKey(lock, npmIndex, name, spec);
    if (resolved) directRequiredNpm.add(resolved);
  }
  for (const [name, spec] of uiRuntimeNpm) {
    const resolved = resolveNpmKey(lock, npmIndex, name, spec);
    if (resolved) directRequiredNpm.add(resolved);
  }
  for (const [name, spec] of uiDevNpm) {
    const resolved = resolveNpmKey(lock, npmIndex, name, spec);
    if (resolved) directDevNpm.add(resolved);
  }

  const jsrRequiredReachable = crawl(directRequiredJsr, (key) => {
    const deps = lock.jsr?.[key]?.dependencies ?? [];
    return deps
      .map((dep) =>
        resolveJsrKey(
          lock,
          jsrKeys,
          dep.startsWith("jsr:") ? dep : `jsr:${dep}`,
        )
      )
      .filter((dep): dep is string => Boolean(dep));
  });
  const jsrDevReachable = crawl(directDevJsr, (key) => {
    const deps = lock.jsr?.[key]?.dependencies ?? [];
    return deps
      .map((dep) =>
        resolveJsrKey(
          lock,
          jsrKeys,
          dep.startsWith("jsr:") ? dep : `jsr:${dep}`,
        )
      )
      .filter((dep): dep is string => Boolean(dep));
  });

  const npmRequiredReachable = crawl(directRequiredNpm, (key) => {
    const deps = lock.npm?.[key]?.dependencies ?? [];
    return deps.flatMap((dep) => candidateNpmKeys(npmIndex, dep));
  });
  const npmDevReachable = crawl(directDevNpm, (key) => {
    const deps = lock.npm?.[key]?.dependencies ?? [];
    return deps.flatMap((dep) => candidateNpmKeys(npmIndex, dep));
  });

  const componentRows: ComponentRow[] = [];

  const rootComponent: ComponentRow = {
    bomRef: `pkg:generic/frosty-deno@${version}`,
    type: "application",
    name: "frosty-deno",
    version,
    ecosystem: "Application",
    purl: `pkg:generic/frosty-deno@${version}`,
    license: "Apache-2.0",
    directness: "Direct",
    scope: "required",
  };
  componentRows.push(rootComponent);

  for (const key of jsrKeys.sort()) {
    const parsed = parseJsrKey(key);
    const directness: Directness =
      directRequiredJsr.has(key) || directDevJsr.has(key)
        ? "Direct"
        : "Transitive";
    const scope: Scope = jsrRequiredReachable.has(key)
      ? "required"
      : jsrDevReachable.has(key)
      ? "dev"
      : "dev";
    componentRows.push({
      bomRef: jsrPurl(parsed.name, parsed.version),
      type: "library",
      name: parsed.name,
      version: parsed.version,
      ecosystem: "JSR",
      purl: jsrPurl(parsed.name, parsed.version),
      license: "NOASSERTION",
      directness,
      scope,
    });
  }

  for (const key of npmKeys.sort()) {
    const parsed = parseNpmKey(key);
    const directness: Directness =
      directRequiredNpm.has(key) || directDevNpm.has(key)
        ? "Direct"
        : "Transitive";
    const scope: Scope = npmRequiredReachable.has(key)
      ? "required"
      : npmDevReachable.has(key)
      ? "dev"
      : "dev";
    componentRows.push({
      bomRef: npmPurl(parsed.name, parsed.version),
      type: "library",
      name: parsed.name,
      version: parsed.version,
      ecosystem: "npm",
      purl: npmPurl(parsed.name, parsed.version),
      license: "NOASSERTION",
      directness,
      scope,
    });
  }

  for (const [name, spec] of browserDevNpm) {
    componentRows.push({
      bomRef: npmPurl(name, spec),
      type: "library",
      name,
      version: spec,
      ecosystem: "npm",
      purl: npmPurl(name, spec),
      license: "NOASSERTION",
      directness: "Direct",
      scope: "dev",
    });
  }

  const dockerImages = [
    ["denoland/deno", "2.9.3"],
    ["denoland/deno", "alpine-2.9.3"],
    ["pgvector/pgvector", "0.8.5-pg18"],
    ["edoburu/pgbouncer", "v1.24.1-p1"],
    ["prom/prometheus", "v2.53.0"],
    ["grafana/grafana", "11.1.0"],
    ["curlimages/curl", "8.11.1"],
    ["otel/opentelemetry-collector-contrib", "0.109.0"],
    ["minio/minio", "RELEASE.2025-09-07T16-13-09Z"],
    ["minio/mc", "RELEASE.2025-08-13T08-35-41Z"],
    ["grafana/tempo", "2.9.0"],
  ] as const;

  for (const [name, imageVersion] of dockerImages) {
    componentRows.push({
      bomRef: dockerPurl(name, imageVersion),
      type: "container",
      name,
      version: imageVersion,
      ecosystem: "Docker",
      purl: dockerPurl(name, imageVersion),
      license: "NOASSERTION",
      directness: "Direct",
      scope: "required",
    });
  }

  const components = componentRows.map<CycloneComponent>((row) => ({
    "bom-ref": row.bomRef,
    type: row.type,
    name: row.name,
    version: row.version,
    purl: row.purl,
    licenses: licenseBlock(row.license),
  }));

  const dependencyEdges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    const bucket = dependencyEdges.get(from) ?? new Set<string>();
    bucket.add(to);
    dependencyEdges.set(from, bucket);
  };

  const directRootRefs = componentRows
    .filter((row) => row.directness === "Direct" && row.name !== "frosty-deno")
    .map((row) => row.bomRef);
  for (const ref of directRootRefs) {
    addEdge(rootComponent.bomRef, ref);
  }

  for (const key of jsrKeys) {
    const from = componentRows.find((row) =>
      row.bomRef === jsrPurl(parseJsrKey(key).name, parseJsrKey(key).version)
    );
    if (!from) continue;
    for (const dep of lock.jsr?.[key]?.dependencies ?? []) {
      const resolved = resolveJsrKey(
        lock,
        jsrKeys,
        dep.startsWith("jsr:") ? dep : `jsr:${dep}`,
      );
      if (!resolved) continue;
      const parsed = parseJsrKey(resolved);
      addEdge(from.bomRef, jsrPurl(parsed.name, parsed.version));
    }
  }

  for (const key of npmKeys) {
    const parsed = parseNpmKey(key);
    const fromRef = npmPurl(parsed.name, parsed.version);
    for (const dep of lock.npm?.[key]?.dependencies ?? []) {
      for (const resolved of candidateNpmKeys(npmIndex, dep)) {
        const depParsed = parseNpmKey(resolved);
        addEdge(fromRef, npmPurl(depParsed.name, depParsed.version));
      }
    }
  }

  const cyclone = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp,
      tools: {
        components: [{
          type: "application",
          name: "GitHub Copilot",
          version: "GPT-5.4",
        }],
      },
      component: components[0],
    },
    components,
    dependencies: [...dependencyEdges.entries()].map(([ref, dependsOn]) => ({
      ref,
      dependsOn: [...dependsOn].sort(),
    })),
  };

  Deno.mkdirSync(new URL("sbom/", docsRoot), { recursive: true });
  Deno.writeTextFileSync(sbomJsonPath, JSON.stringify(cyclone, null, 2) + "\n");

  const licenseCounts = new Map<string, number>();
  for (const row of componentRows) {
    licenseCounts.set(row.license, (licenseCounts.get(row.license) ?? 0) + 1);
  }

  const byEcosystem = new Map<string, ComponentRow[]>();
  for (const row of componentRows) {
    const bucket = byEcosystem.get(row.ecosystem) ?? [];
    bucket.push(row);
    byEcosystem.set(row.ecosystem, bucket);
  }

  const requiredDirect =
    componentRows.filter((row) =>
      row.directness === "Direct" && row.scope === "required"
    ).length - 1;
  const devDirect =
    componentRows.filter((row) =>
      row.directness === "Direct" && row.scope === "dev"
    ).length;
  const transitive =
    componentRows.filter((row) => row.directness === "Transitive").length;

  const md: string[] = [];
  md.push("# Software Bill of Materials (SBOM)", "");
  md.push("## Document Metadata", "");
  md.push(`- Project name: Frosty Deno`);
  md.push(`- Project version: ${version}`);
  md.push(
    `- Description: Deno 2 + TypeScript LLM gateway with a same-origin React control plane and PostgreSQL-backed durable state.`,
  );
  md.push(`- SBOM timestamp: ${timestamp}`);
  md.push(
    `- Author/tool: GitHub Copilot (GPT-5.4) using the checked-in manifests and lockfile only.`,
  );
  md.push(`- Format: CycloneDX JSON 1.5 plus this human-readable summary.`);
  md.push(`- Lifecycle phase: source / pre-build`, "");

  md.push("## Component Inventory", "");
  for (const ecosystem of ["Application", "JSR", "npm", "Docker"] as const) {
    const rows = (byEcosystem.get(ecosystem) ?? []).sort((a, b) => {
      if (a.directness !== b.directness) {
        return a.directness === "Direct" ? -1 : 1;
      }
      return a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
    });
    if (rows.length === 0) continue;
    md.push(`### ${ecosystem}`, "");
    md.push(...tableFor(rows), "");
  }

  md.push("## License Summary", "");
  md.push("| License | Count | Review Note |", "| --- | --- | --- |");
  for (
    const [license, count] of [...licenseCounts.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    )
  ) {
    const note = license === "NOASSERTION"
      ? "License could not be derived from checked-in manifests or lockfiles."
      : license === "Apache-2.0"
      ? "Repository root license."
      : "Review required.";
    md.push(`| ${license} | ${count} | ${note} |`);
  }
  md.push("");

  md.push("## Dependency Relationships", "");
  md.push(`- Direct required components: ${requiredDirect}`);
  md.push(`- Direct development components: ${devDirect}`);
  md.push(`- Transitive components: ${transitive}`);
  md.push(`- Locked JSR components from deno.lock: ${jsrKeys.length}`);
  md.push(`- Locked npm components from deno.lock: ${npmKeys.length}`);
  md.push(
    `- Browser harness note: tests/browser declares \`@playwright/test\` in package.json but does not ship its own lockfile, so the SBOM records the declared range rather than an exact resolved version.`,
    "",
  );

  md.push("## Known Vulnerabilities", "");
  md.push(
    "Vulnerability scanning was not performed as part of this documentation pass. Recommended follow-up commands:",
    "",
  );
  md.push("- `deno run -A scripts/generate_sbom.ts`");
  md.push("- `osv-scanner --lockfile=deno.lock`");
  md.push("- `npm audit --prefix tests/browser`");
  md.push("- `trivy fs .`");
  md.push("- `docker scout cves denoland/deno:alpine-2.9.3`", "");

  md.push("## Generation and Maintenance", "");
  md.push(
    "- Regenerate the machine-readable and human-readable SBOM with `deno run -A scripts/generate_sbom.ts`.",
  );
  md.push(
    "- Regenerate on every dependency change and every release candidate or release cut.",
  );
  md.push(
    "- Add the SBOM generation command and the vulnerability scans above to CI if the repository later adopts automation.",
  );

  Deno.writeTextFileSync(sbomMdPath, md.join("\n") + "\n");

  const fmt = new Deno.Command(Deno.execPath(), {
    args: ["fmt", fromFileUrl(sbomMdPath)],
    stdout: "null",
    stderr: "null",
  }).outputSync();
  if (!fmt.success) {
    throw new Error("Failed to format generated sbom.md");
  }

  console.log(`Wrote ${sbomMdPath.pathname}`);
  console.log(`Wrote ${sbomJsonPath.pathname}`);
}

if (import.meta.main) {
  main();
}
