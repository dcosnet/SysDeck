import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MaskedSecret, MaskedSecretCell, maskSecret } from "./masked-secret";

const SECRET = "sk-bf-DO-NOT-LEAK-1234567890";

describe("maskSecret", () => {
  it("keeps a short prefix and hides the remainder behind fixed dots", () => {
    const masked = maskSecret(SECRET, 6);
    expect(masked.startsWith("sk-bf-")).toBe(true);
    expect(masked).not.toContain("LEAK");
    // dot count is constant, independent of the true length
    expect(maskSecret("sk-x", 6)).toContain("•");
  });
});

describe("MaskedSecret", () => {
  it("masks by default and reveals on toggle", async () => {
    const user = userEvent.setup();
    render(<MaskedSecret value={SECRET} label="API key" />);

    const field = screen.getByRole("textbox", { name: "API key" });
    expect(field).toHaveValue(maskSecret(SECRET, 6));
    expect(field).not.toHaveValue(SECRET);

    await user.click(screen.getByRole("button", { name: "Reveal API key" }));
    expect(field).toHaveValue(SECRET);
  });
});

describe("MaskedSecretCell", () => {
  it("shows masked text until revealed", async () => {
    const user = userEvent.setup();
    render(<MaskedSecretCell value={SECRET} label="token" />);

    expect(screen.queryByText(SECRET)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reveal token" }));
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy token" }))
      .toBeInTheDocument();
  });
});
