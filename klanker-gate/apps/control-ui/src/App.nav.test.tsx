// Navigation restructure: Status moved to Overview, Cache and Config folded
// into Settings tabs, and the legacy hashes kept working.
//
// The redirect cases are the ones worth locking. Removing a nav leaf is
// visible immediately; a bookmark that silently lands on the wrong view is not,
// and reads as a broken link rather than as a reorganization.

import { describe, expect, it } from "vitest";
import { redirectFor } from "./App";

describe("legacy hash redirects", () => {
  it("sends the old Cache page to the Settings caching tab", () => {
    expect(redirectFor("#/cache")).toBe("settings/caching");
  });

  it("sends the old Config page to the Settings config tab", () => {
    expect(redirectFor("#/config")).toBe("settings/config");
  });

  it("tolerates the hash with and without a leading slash", () => {
    expect(redirectFor("#cache")).toBe("settings/caching");
    expect(redirectFor("#/cache")).toBe("settings/caching");
  });

  it("leaves current routes alone", () => {
    for (const hash of ["#/status", "#/settings", "#/providers", "#/logs"]) {
      expect(redirectFor(hash)).toBeNull();
    }
  });

  it("leaves an already-migrated settings sub-route alone", () => {
    // Redirecting this would loop: the destination contains the source token.
    expect(redirectFor("#/settings/caching")).toBeNull();
    expect(redirectFor("#/settings/config")).toBeNull();
  });

  it("does not invent a destination for a deep legacy path", () => {
    // "#/cache/anything" was never a route this app minted. Rewriting it would
    // guess at an intent that was never expressed.
    expect(redirectFor("#/cache/entry/123")).toBeNull();
    expect(redirectFor("#/config/export")).toBeNull();
  });

  it("ignores an empty or unknown hash", () => {
    expect(redirectFor("")).toBeNull();
    expect(redirectFor("#/")).toBeNull();
    expect(redirectFor("#/nonsense")).toBeNull();
  });
});
