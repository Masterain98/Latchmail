import { z } from "zod";

export const idSchema = z.string().uuid();
export const domainCreateSchema = z
  .object({
    domain: z.string().min(1).max(253),
    note: z.string().max(2000).nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export const domainPatchSchema = z
  .object({
    note: z.string().max(2000).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export const tagCreateSchema = z
  .object({ name: z.string().min(1).max(128) })
  .strict();
export const addressCreateSchema = z
  .object({
    domain_id: idSchema,
    local_part: z.string().min(1).max(64),
    tag_id: idSchema.nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();
export const addressPatchSchema = z
  .object({
    tag_id: idSchema.nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .strict();
export const messagePatchSchema = z
  .object({
    is_read: z.boolean().optional(),
    is_archived: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const settingsPatchSchema = z
  .object({ attachment_retention_days: z.number().int().min(1).max(3650) })
  .strict();
export const webhookPutSchema = z
  .object({
    enabled: z.boolean(),
    url: z.string().url().max(2048).nullable(),
    confirm_cancel_pending: z.boolean().default(false),
  })
  .strict();
export const loginSchema = z
  .object({ password: z.string().min(32).max(4096) })
  .strict();

export const parseStates = ["queued", "processing", "ready", "failed"] as const;
export const deliveryStates = [
  "waiting_content",
  "pending",
  "inflight",
  "retry_wait",
  "paused",
  "succeeded",
  "failed",
  "expired",
  "canceled",
] as const;

export interface RegistrationSnapshot {
  address_id: string;
  address: string;
  tag: { id: string; name: string } | null;
  note: string | null;
}
export interface MailAddress {
  address: string;
  name: string | null;
}
export interface WebhookPayload {
  schema_version: "1.0";
  event: "email.received" | "webhook.test";
  event_id: string;
  occurred_at: string;
  data: {
    message_id: string;
    domain: string;
    received_at: string;
    envelope: { from: string; to: string; to_normalized: string };
    registration: RegistrationSnapshot | null;
    parse_status: "ready" | "failed";
    parse_error: string | null;
    headers: Array<{ name: string; value: string }> | null;
    rfc_message_id: string | null;
    from: MailAddress | null;
    to: MailAddress[] | null;
    cc: MailAddress[] | null;
    reply_to: MailAddress[] | null;
    bcc_observed: MailAddress[];
    subject: string | null;
    text: string | null;
    html: string | null;
    attachments: Array<{
      id: string;
      filename: string;
      content_type: string;
      disposition: string | null;
      content_id: string | null;
      size_bytes: number;
      sha256: string;
      expires_at: string;
    }> | null;
    raw_email: {
      part_name: "raw_email";
      filename: string;
      content_type: "message/rfc822";
      size_bytes: number;
      sha256: string;
      expires_at: string;
    };
  };
}
