import { describe, expect, it } from "vitest";
import { filterNav, groupsOf } from "./nav";

const items = [
  { id: "providers", label: "Providers", group: "Gateway" },
  { id: "status", label: "Status", group: "Gateway" },
  { id: "virtual-keys", label: "Virtual keys", group: "Governance" },
  { id: "dashboard", label: "Dashboard", group: "Analytics" },
];

describe("filterNav", () => {
  it("returns every item for an empty query", () => {
    expect(filterNav(items, "")).toHaveLength(4);
    expect(filterNav(items, "   ")).toHaveLength(4);
  });

  it("matches item labels case-insensitively", () => {
    const hits = filterNav(items, "dash");
    expect(hits.map((i) => i.id)).toEqual(["dashboard"]);
  });

  it("matches by group name too", () => {
    const hits = filterNav(items, "gateway");
    expect(hits.map((i) => i.id)).toEqual(["providers", "status"]);
  });

  it("returns nothing when there is no match", () => {
    expect(filterNav(items, "zzz")).toHaveLength(0);
  });
});

describe("groupsOf", () => {
  it("lists groups in first-seen order without duplicates", () => {
    expect(groupsOf(items)).toEqual(["Gateway", "Governance", "Analytics"]);
  });
});
