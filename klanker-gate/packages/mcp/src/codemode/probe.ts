/** True when an error is a per-worker permission denial (either error class). */
function isPermissionDenial(error: unknown): boolean {
  return error instanceof Deno.errors.PermissionDenied ||
    error instanceof Deno.errors.NotCapable;
}

type ProbeVerdict = "denied" | "allowed" | "other";

async function classify(
  attempt: () => unknown | Promise<unknown>,
): Promise<ProbeVerdict> {
  try {
    await attempt();
    // The op SUCCEEDED — the descriptor was ignored / not enforced. Dangerous.
    return "allowed";
  } catch (error) {
    return isPermissionDenial(error) ? "denied" : "other";
  }
}

const scope = self as unknown as { postMessage(message: unknown): void };

const env = await classify(() => Deno.env.get("PATH"));
const read = await classify(() => Deno.readFile("data/frosty.kv"));
const net = await classify(() =>
  fetch("http://169.254.169.254/latest/meta-data/")
);

scope.postMessage({ type: "probe_result", env, read, net });
