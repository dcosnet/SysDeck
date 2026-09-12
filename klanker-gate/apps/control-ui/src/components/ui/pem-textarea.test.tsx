import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isLikelyPem, PemTextarea } from "./pem-textarea";

const VALID_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBcap\n-----END CERTIFICATE-----";

describe("isLikelyPem", () => {
  it("treats empty as valid and requires delimiters otherwise", () => {
    expect(isLikelyPem("")).toBe(true);
    expect(isLikelyPem("   ")).toBe(true);
    expect(isLikelyPem("not a cert")).toBe(false);
    expect(isLikelyPem(VALID_PEM)).toBe(true);
  });
});

describe("PemTextarea", () => {
  it("flags malformed input without blocking entry", () => {
    render(
      <PemTextarea value="garbage" onChange={vi.fn()} label="CA Certificate" />,
    );
    const field = screen.getByRole("textbox", { name: "CA Certificate" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveValue("garbage");
    expect(screen.getByText(/Expected PEM delimiters/)).toBeInTheDocument();
  });

  it("shows no warning for valid PEM", () => {
    render(
      <PemTextarea
        value={VALID_PEM}
        onChange={vi.fn()}
        label="CA Certificate"
      />,
    );
    expect(screen.getByRole("textbox", { name: "CA Certificate" }))
      .not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(/Expected PEM delimiters/)).toBeNull();
  });
});
