import { useEffect, useState } from "react";
import { FileCode } from "lucide-react";
import {
  type CodeModeBinding,
  type CodeModeVfsView,
  getCodeModeVfs,
} from "../../api";
import { Badge } from "../ui/badge";
import { Collapsible } from "../ui/collapsible";
import { Skeleton } from "../ui/skeleton";
import { relativeTime } from "../../lib/utils";

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export interface CodeModeVfsPreviewProps {
  binding: CodeModeBinding;
}

/** Read-only preview of the generated Code Mode virtual file system. */
export function CodeModeVfsPreview({ binding }: CodeModeVfsPreviewProps) {
  const [view, setView] = useState<CodeModeVfsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getCodeModeVfs(binding)
      .then((next) => {
        if (active) {
          setView(next);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [binding]);

  const files = view?.files ?? [];
  const rootLabel = binding === "tool" ? "tools/" : "servers/";
  const caption = binding === "tool"
    ? "Individual tool files."
    : "All tools per server in a single .py file.";

  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        VFS Structure
      </p>
      <div className="rounded-lg border border-border bg-muted/30 p-4">
        {loading
          ? (
            <div className="flex flex-col gap-2" aria-hidden="true">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-36" />
            </div>
          )
          : error
          ? (
            <p className="text-sm text-muted-foreground">
              The generated VFS is unavailable ({error}).
            </p>
          )
          : files.length === 0
          ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileCode aria-hidden="true" className="size-4" />
              No generated files for this binding level.
            </div>
          )
          : (
            <div className="flex flex-col gap-4">
              {/* Tree glance: file names are untrusted -> text nodes only. */}
              <div className="font-mono text-sm text-foreground">
                <div>{rootLabel}</div>
                {files.map((file, index) => (
                  <div key={file.path} className="whitespace-pre">
                    {(index === files.length - 1 ? "  └ " : "  ├ ") +
                      baseName(file.path)}
                  </div>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">{caption}</p>

              {/* Per-file expandable source (escaped text throughout). */}
              <div className="rounded-md border border-border bg-card">
                {files.map((file) => (
                  <div key={file.path} className="px-3">
                    <Collapsible
                      title={
                        <span className="font-mono text-sm text-foreground">
                          {file.path}
                        </span>
                      }
                      aside={
                        <Badge tone="muted">
                          {formatBytes(file.sizeBytes)}
                        </Badge>
                      }
                    >
                      <div className="flex flex-col gap-2 pb-1">
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                          <dt className="text-muted-foreground">server</dt>
                          <dd className="font-mono text-foreground">
                            {file.server}
                          </dd>
                          <dt className="text-muted-foreground">tools</dt>
                          <dd className="font-mono text-foreground">
                            {file.tools.length > 0
                              ? file.tools.join(", ")
                              : "-"}
                          </dd>
                          <dt className="text-muted-foreground">sha256</dt>
                          <dd className="truncate font-mono text-muted-foreground">
                            {file.sha256 || "-"}
                          </dd>
                        </dl>
                        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground">{file.source}</pre>
                      </div>
                    </Collapsible>
                  </div>
                ))}
              </div>
            </div>
          )}
      </div>
      {view && !loading && !error && (
        <p className="text-2xs text-muted-foreground">
          Generated {relativeTime(view.generatedAt)}.
        </p>
      )}
    </div>
  );
}
