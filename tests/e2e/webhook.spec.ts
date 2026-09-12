import { expect, test } from "@playwright/test";

test("shows the dedicated webhook workspace and keeps settings separate", async ({
  page,
}) => {
  const recordId = "11111111-1111-4111-8111-111111111111";
  await page.addInitScript(() => localStorage.setItem("latchmail.locale", "en"));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data }),
      });
    if (path === "/api/auth/session") return json({ csrf: "test-csrf" });
    if (path === "/api/webhook")
      return json({
        enabled: true,
        url: "https://hooks.example.com/email",
        revision: 3,
        signing_secret_configured: true,
        updated_at: "2026-09-11T18:00:00.000Z",
      });
    if (path === "/api/webhook/records")
      return json({
        records: [
          {
            id: recordId,
            delivery_id: "22222222-2222-4222-8222-222222222222",
            event_id: "33333333-3333-4333-8333-333333333333",
            kind: "email",
            attempt_number: 1,
            endpoint_url: "https://hooks.example.com/email",
            started_at: "2026-09-11T18:00:00.000Z",
            finished_at: "2026-09-11T18:00:00.042Z",
            result: "succeeded",
            http_status: 202,
            duration_ms: 42,
            error_code: null,
            response_content_type: "application/json",
            response_captured_bytes: 17,
            response_truncated: false,
            response_excerpt: '{"accepted":true}',
            expires_at: "2026-09-13T18:00:00.042Z",
            subject_preview: "Build receipt",
            envelope_to_normalized: "builds@example.com",
          },
        ],
        next_cursor: null,
      });
    if (path === `/api/webhook/records/${recordId}`)
      return json({
        id: recordId,
        delivery_id: "22222222-2222-4222-8222-222222222222",
        event_id: "33333333-3333-4333-8333-333333333333",
        kind: "email",
        attempt_number: 1,
        endpoint_url: "https://hooks.example.com/email",
        started_at: "2026-09-11T18:00:00.000Z",
        finished_at: "2026-09-11T18:00:00.042Z",
        result: "succeeded",
        http_status: 202,
        duration_ms: 42,
        error_code: null,
        response_content_type: "application/json",
        response_captured_bytes: 17,
        response_truncated: false,
        response_excerpt: '{"accepted":true}',
        expires_at: "2026-09-13T18:00:00.042Z",
        request_headers: {
          "Content-Type": "multipart/form-data; boundary=latchmail-record",
          "X-Inbox-Signature": "v1,[NOT RETAINED]",
        },
        raw_filename: "message.eml",
        payload_size_bytes: 512,
        raw_size_bytes: 1024,
        capture_error_code: null,
      });
    if (path === `/api/webhook/records/${recordId}/payload`)
      return route.fulfill({
        contentType: "application/json",
        body: '{"event":"email.received"}',
      });
    if (path === `/api/webhook/records/${recordId}/response`)
      return route.fulfill({
        contentType: "application/json",
        body: '{"accepted":true}',
      });
    if (path === "/api/domains" || path === "/api/tags") return json([]);
    if (path === "/api/settings")
      return json({ attachment_retention_days: 30 });
    if (path === "/api/system/status")
      return json({
        pending_parse: 0,
        failed_parse: 0,
        pending_webhooks: 0,
        failed_webhooks: 0,
        pending_delete: 0,
        maintenance: { last_scheduled_at: null },
      });
    return route.fulfill({ status: 404, body: "not mocked" });
  });

  await page.goto("/webhook");
  await expect(page.getByRole("heading", { name: "Webhook", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Send records" })).toBeVisible();
  await page.getByRole("button", { name: /Build receipt/ }).click();
  await expect(page.getByRole("heading", { name: "Send details" })).toBeVisible();
  await expect(page.getByText("https://hooks.example.com/email").last()).toBeVisible();
  await expect(page.getByText('{"accepted":true}')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: "Webhook" })).toBeVisible();
  await page.getByRole("link", { name: "Settings & operations" }).click();
  await expect(page.getByRole("heading", { name: "Attachment retention" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Complete-message delivery" })).toHaveCount(0);
});
