import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom does not implement scrollIntoView.
Element.prototype.scrollIntoView = vi.fn();

// jsdom has no EventSource; the LogsView tests stub it.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {}
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

(globalThis as Record<string, unknown>).EventSource = FakeEventSource;
(globalThis as Record<string, unknown>).__FakeEventSource = FakeEventSource;
