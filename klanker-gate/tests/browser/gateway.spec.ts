import { expect, test } from "@playwright/test";

// End-to-end browser flows against the deployed gateway + control UI.
//
// These run against a REAL gateway backed by a persistent PostgreSQL volume, so
// they cannot assume a clean database. Cleaning up only at the end of each test
// is not enough: one failed or interrupted run leaves `e2e-openai` /`e2e-mcp`
// behind, and every later run then fails on the duplicate. Fixtures are
// therefore removed BEFORE each test as well, ignoring "not found".

const FIXTURES = [
  "/api/providers/e2e-openai",
  "/api/mcp/clients/e2e-mcp",
];

test.beforeEach(async ({ request }) => {
  for (const path of FIXTURES) {
    // A 404 is the expected result on a clean database.
    await request.delete(path).catch(() => {});
  }
});

test("control plane shell loads with all sections", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Klanker Gateway Manager" }))
    .toBeVisible();
  for (const tab of ["Providers", "Status", "Logs", "Extensions"]) {
    await expect(page.getByRole("button", { name: tab })).toBeVisible();
  }
});

test("provider add/delete round-trip never renders the secret", async ({ page }) => {
  const secret = "sk-e2e-secret-do-not-render-1234567890";
  await page.goto("/");

  await page.getByLabel("ID").fill("e2e-openai");
  await page.getByLabel("API key").fill(secret);
  await page.getByRole("button", { name: "Add provider" }).click();

  const row = page.getByRole("row", { name: /e2e-openai/ });
  await expect(row).toBeVisible();
  // Presence is shown as a status badge, never as the value. An enabled
  // account holding credentials reads "online"; without them it reads
  // "no key". Either way the secret itself must not be in the document.
  await expect(row.getByText(/online|no key/)).toBeVisible();

  // The key must never appear anywhere in the served document.
  expect(await page.content()).not.toContain(secret);

  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row).toBeHidden();
});

test("MCP server registration defaults to the SSE transport", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Extensions" }).click();

  await page.getByLabel("ID").fill("e2e-mcp");
  await page.getByLabel("URL").fill("http://127.0.0.1:59999/rpc");
  // Transport selector left at its default — asserting D11 end to end.
  await page.getByRole("button", { name: "Add MCP server" }).click();

  const row = page.getByRole("row", { name: /e2e-mcp/ });
  await expect(row).toBeVisible();
  await expect(row.getByText("http-sse")).toBeVisible();

  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row).toBeHidden();
});

test("status tab reports live gateway health", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Status" }).click();
  await expect(page.getByText("Gateway health")).toBeVisible();
  await expect(page.getByText("ok", { exact: true })).toBeVisible();
  await expect(page.getByText(/gateway v\d+\.\d+\.\d+/)).toBeVisible();
});
