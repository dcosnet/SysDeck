import { describe, expect, it } from "vitest";
import { clampPage, pageInfo, paginate, sortRows } from "./table";

interface Row {
  name: string;
  used: number;
}

const rows: Row[] = [
  { name: "beta", used: 30 },
  { name: "alpha", used: 10 },
  { name: "gamma", used: 20 },
];

describe("sortRows", () => {
  it("sorts by a string key ascending and descending without mutating", () => {
    const asc = sortRows(rows, (r) => r.name, "asc");
    expect(asc.map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
    const desc = sortRows(rows, (r) => r.name, "desc");
    expect(desc.map((r) => r.name)).toEqual(["gamma", "beta", "alpha"]);
    // original untouched
    expect(rows[0].name).toBe("beta");
  });

  it("sorts by a numeric key numerically", () => {
    const asc = sortRows(rows, (r) => r.used, "asc");
    expect(asc.map((r) => r.used)).toEqual([10, 20, 30]);
  });

  it("is stable for equal keys", () => {
    const tied = [
      { name: "a", used: 1 },
      { name: "b", used: 1 },
      { name: "c", used: 1 },
    ];
    const sorted = sortRows(tied, (r) => r.used, "asc");
    expect(sorted.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });
});

describe("paginate", () => {
  it("slices a zero-based page", () => {
    const list = [1, 2, 3, 4, 5];
    expect(paginate(list, 0, 2)).toEqual([1, 2]);
    expect(paginate(list, 1, 2)).toEqual([3, 4]);
    expect(paginate(list, 2, 2)).toEqual([5]);
  });
});

describe("clampPage", () => {
  it("keeps the page index inside range", () => {
    expect(clampPage(5, 10, 3)).toBe(3); // 4 pages -> max index 3
    expect(clampPage(-2, 10, 3)).toBe(0);
    expect(clampPage(0, 0, 3)).toBe(0);
  });
});

describe("pageInfo", () => {
  it("labels an empty set", () => {
    expect(pageInfo(0, 0, 10).label).toBe("Showing 0 of 0");
  });

  it("labels a bounded window", () => {
    expect(pageInfo(42, 0, 10)).toMatchObject({
      start: 1,
      end: 10,
      pageCount: 5,
      label: "Showing 1-10 of 42",
    });
    expect(pageInfo(42, 4, 10).label).toBe("Showing 41-42 of 42");
  });
});
