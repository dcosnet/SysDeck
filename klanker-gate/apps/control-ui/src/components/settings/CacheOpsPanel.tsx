import { useState } from "react";
import { clearCache, deleteCacheEntry } from "../../api";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Button } from "../ui/button";
import { Field } from "../ui/label";
import { Textarea } from "../ui/input";
import { ConfirmDialog } from "../ui/dialog";
import { useToast } from "../ui/toast";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function CacheOpsPanel() {
  const toast = useToast();
  const [confirmPurgeAll, setConfirmPurgeAll] = useState(false);
  const [purgingAll, setPurgingAll] = useState(false);
  const [body, setBody] = useState("");
  const [purgingOne, setPurgingOne] = useState(false);

  function parsedBody(): unknown | undefined {
    if (!body.trim() || body.length > MAX_BODY_BYTES) {
      return undefined;
    }
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }

  const bodyError =
    body.trim() && body.length <= MAX_BODY_BYTES && parsedBody() === undefined
      ? "Not valid JSON."
      : body.length > MAX_BODY_BYTES
      ? "Request JSON is too large (over 2 MB)."
      : null;
  const bodyReady = body.trim() !== "" && bodyError === null;

  function purgeAll() {
    setPurgingAll(true);
    setConfirmPurgeAll(false);
    clearCache()
      .then((res) => toast.success(`Cleared ${res.cleared} cached entries`))
      .catch((err) =>
        toast.error(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setPurgingAll(false));
  }

  function purgeOne() {
    const parsed = parsedBody();
    if (parsed === undefined) {
      return;
    }
    setPurgingOne(true);
    deleteCacheEntry(parsed)
      .then((res) => {
        if (res.deleted) {
          toast.success("Cache entry deleted");
        } else {
          toast.info("No matching cache entry");
        }
      })
      .catch((err) =>
        toast.error(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setPurgingOne(false));
  }

  return (
    <div>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Purge everything</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            Every cached completion is dropped immediately. Identical requests
            will hit providers again and incur cost. When caching is disabled
            (FROSTY_CACHE unset) this is a no-op.
          </p>
          <Button
            variant="destructive"
            isLoading={purgingAll}
            onClick={() => setConfirmPurgeAll(true)}
          >
            Purge cache
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Purge one entry</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-sm text-muted-foreground">
            Paste the exact request body that produced the cached completion.
          </p>
          <Field id="cache-key" label="Request JSON" className="measure">
            <Textarea
              id="cache-key"
              rows={8}
              className="font-mono"
              value={body}
              aria-invalid={bodyError ? true : undefined}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          {bodyError && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {bodyError}
            </p>
          )}
          <div className="mt-3">
            <Button
              disabled={!bodyReady}
              isLoading={purgingOne}
              onClick={purgeOne}
            >
              Purge entry
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmPurgeAll}
        onClose={() => setConfirmPurgeAll(false)}
        onConfirm={purgeAll}
        title="Purge entire cache?"
        confirmLabel="Purge cache"
        pending={purgingAll}
        body="Every cached completion is dropped immediately. Identical requests will hit providers again and incur cost."
      />
    </div>
  );
}
