import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Avatar,
  initialsFrom,
  providerGlyph,
  ProviderIcon,
} from "./provider-icon";

describe("initialsFrom", () => {
  it("derives up to two initials", () => {
    expect(initialsFrom("OpenAI")).toBe("OP");
    expect(initialsFrom("Acme Corp")).toBe("AC");
    expect(initialsFrom("lm-studio")).toBe("LS");
  });
});

describe("providerGlyph", () => {
  it("resolves known providers and tolerates -compatible suffixes", () => {
    expect(providerGlyph("openai")).not.toBeNull();
    expect(providerGlyph("anthropic-compatible")).not.toBeNull();
    expect(providerGlyph("totally-unknown")).toBeNull();
  });
});

describe("ProviderIcon", () => {
  it("labels a known provider glyph", () => {
    render(<ProviderIcon provider="anthropic" name="Anthropic" />);
    const icon = screen.getByRole("img", { name: "Anthropic" });
    expect(icon.querySelector("svg")).not.toBeNull();
  });

  it("falls back to initials for an unknown provider", () => {
    render(<ProviderIcon provider="acme" name="Acme Corp" />);
    expect(screen.getByText("AC")).toBeInTheDocument();
  });

  it("renders a generic glyph for custom providers", () => {
    render(<ProviderIcon provider="acme" name="MiMo" custom />);
    const icon = screen.getByRole("img", { name: "MiMo" });
    expect(icon.querySelector("svg")).not.toBeNull();
    expect(screen.queryByText("MI")).toBeNull();
  });
});

describe("Avatar", () => {
  it("renders initials with an accessible name", () => {
    render(<Avatar name="Jane Doe" />);
    expect(screen.getByRole("img", { name: "Jane Doe" })).toHaveTextContent(
      "JD",
    );
  });
});
