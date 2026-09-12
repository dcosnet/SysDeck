import { describe, expect, it } from "vitest";
import { type CsvColumn, escapeCsvCell, toCsv } from "./csv";

describe("escapeCsvCell", () => {
  it("passes through simple values and blanks nullish ones", () => {
    expect(escapeCsvCell("abc")).toBe("abc");
    expect(escapeCsvCell(5)).toBe("5");
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
  });

  it("quotes cells containing delimiters and escapes quotes", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  it("neutralizes spreadsheet formula-injection prefixes on strings", () => {
    expect(escapeCsvCell("=1+1")).toBe("'=1+1");
    expect(escapeCsvCell("@cmd")).toBe("'@cmd");
    // numbers are never rewritten
    expect(escapeCsvCell(-3)).toBe("-3");
  });
});

interface Row {
  name: string;
  used: number;
}

const columns: CsvColumn<Row>[] = [
  { header: "Name", value: (r) => r.name },
  { header: "Used", value: (r) => r.used },
];

describe("toCsv", () => {
  it("emits a header line plus one CRLF-joined line per row", () => {
    const csv = toCsv(
      [{ name: "alpha", used: 1 }, { name: "beta", used: 2 }],
      columns,
    );
    expect(csv).toBe("Name,Used\r\nalpha,1\r\nbeta,2");
  });

  it("emits only the header for an empty set", () => {
    expect(toCsv([], columns)).toBe("Name,Used");
  });
});
