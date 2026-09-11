import { expect, test } from "@playwright/test";

test("switches between English and Chinese and persists the choice", async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("latchmail.locale"))
      localStorage.setItem("latchmail.locale", "en");
  });
  await page.goto("/");
  await expect(page).toHaveTitle("Latchmail");
  await expect(page.getByRole("heading", { name: "Your mail console" })).toBeVisible();
  await expect(page.getByLabel("Admin password")).toBeVisible();
  await page.getByRole("button", { name: "Switch language" }).click();
  await expect(page.getByRole("heading", { name: "你的收件台" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "你的收件台" })).toBeVisible();
  await expect(page.getByText(/写信|回复|AI 助手/)).toHaveCount(0);
});
