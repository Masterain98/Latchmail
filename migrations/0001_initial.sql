PRAGMA foreign_keys = ON;

CREATE TABLE domains (
  id TEXT PRIMARY KEY, domain_ascii TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  note TEXT, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_received_at INTEGER
);
CREATE TABLE tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, name_normalized TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE address_registry (
  id TEXT PRIMARY KEY, domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
  local_part TEXT NOT NULL, address_normalized TEXT NOT NULL UNIQUE,
  tag_id TEXT REFERENCES tags(id) ON DELETE RESTRICT, note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_addresses_tag ON address_registry(tag_id,address_normalized);
CREATE INDEX idx_addresses_domain ON address_registry(domain_id,address_normalized);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE RESTRICT,
  received_at INTEGER NOT NULL, envelope_from TEXT NOT NULL, envelope_to_original TEXT NOT NULL, envelope_to_normalized TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL, raw_size_bytes INTEGER NOT NULL CHECK(raw_size_bytes >= 0),
  subject_preview TEXT, from_preview TEXT, message_id_header TEXT, snippet TEXT, attachment_count INTEGER,
  raw_object_key TEXT NOT NULL UNIQUE, raw_expires_at INTEGER NOT NULL,
  raw_state TEXT NOT NULL DEFAULT 'available' CHECK(raw_state IN ('available','deleting','deleted','missing')), raw_deleted_at INTEGER,
  content_object_key TEXT, content_sha256 TEXT, content_size_bytes INTEGER, active_parse_run_id TEXT,
  is_read INTEGER NOT NULL DEFAULT 0 CHECK(is_read IN (0,1)), is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0,1)),
  deleted_at INTEGER, purge_state TEXT NOT NULL DEFAULT 'none' CHECK(purge_state IN ('none','queued','processing','complete','failed')),
  registration_snapshot_json TEXT, retention_days_snapshot INTEGER NOT NULL CHECK(retention_days_snapshot BETWEEN 1 AND 3650),
  notification_requested INTEGER NOT NULL CHECK(notification_requested IN (0,1)),
  parse_state TEXT NOT NULL DEFAULT 'queued' CHECK(parse_state IN ('queued','processing','ready','failed')),
  parse_attempts INTEGER NOT NULL DEFAULT 0, parse_next_attempt_at INTEGER, parse_lease_token TEXT, parse_lease_until INTEGER, parse_error_code TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_received ON messages(received_at DESC,id DESC);
CREATE INDEX idx_messages_domain_received ON messages(domain_id,received_at DESC,id DESC);
CREATE INDEX idx_messages_recipient_received ON messages(envelope_to_normalized,received_at DESC,id DESC);
CREATE INDEX idx_messages_box ON messages(is_archived,is_read,received_at DESC,id DESC);
CREATE INDEX idx_messages_parse ON messages(parse_state,parse_next_attempt_at);
CREATE INDEX idx_messages_raw_expiry ON messages(raw_state,raw_expires_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, parse_run_id TEXT NOT NULL,
  part_index INTEGER NOT NULL, object_key TEXT NOT NULL UNIQUE, filename_original TEXT, filename_download TEXT NOT NULL,
  content_type TEXT NOT NULL, disposition TEXT, content_id TEXT, size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0), sha256 TEXT NOT NULL,
  expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'available' CHECK(state IN ('available','deleting','deleted','missing')),
  deleted_at INTEGER, cleanup_attempts INTEGER NOT NULL DEFAULT 0, cleanup_next_attempt_at INTEGER, cleanup_error_code TEXT,
  UNIQUE(message_id,parse_run_id,part_index)
);
CREATE INDEX idx_attachments_expiry ON attachments(state,expires_at);
CREATE INDEX idx_attachments_cleanup ON attachments(state,cleanup_next_attempt_at);

CREATE TABLE app_settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), attachment_retention_days INTEGER NOT NULL DEFAULT 30 CHECK(attachment_retention_days BETWEEN 1 AND 3650),
  webhook_enabled INTEGER NOT NULL DEFAULT 0 CHECK(webhook_enabled IN (0,1)), webhook_url TEXT, webhook_revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
);
INSERT INTO app_settings(singleton,attachment_retention_days,webhook_enabled,webhook_revision,updated_at) VALUES(1,30,0,1,0);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, event_id TEXT NOT NULL,
  endpoint_url_snapshot TEXT NOT NULL, endpoint_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('waiting_content','pending','inflight','retry_wait','paused','succeeded','failed','expired','canceled')),
  attempts_total INTEGER NOT NULL DEFAULT 0, cycle_attempts INTEGER NOT NULL DEFAULT 0, cycle_started_at INTEGER,
  next_attempt_at INTEGER, retry_deadline_at INTEGER, lease_token TEXT, lease_until INTEGER,
  last_http_status INTEGER, last_error_code TEXT, delivered_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(event_id,endpoint_revision)
);
CREATE INDEX idx_deliveries_due ON webhook_deliveries(status,next_attempt_at);
CREATE INDEX idx_deliveries_message ON webhook_deliveries(message_id,created_at DESC);
CREATE TABLE webhook_attempts (
  id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, http_status INTEGER, duration_ms INTEGER,
  result TEXT NOT NULL, error_code TEXT, response_excerpt TEXT, UNIQUE(delivery_id,attempt_number)
);
CREATE INDEX idx_attempts_delivery ON webhook_attempts(delivery_id,attempt_number DESC);

CREATE TABLE receive_dedup (
  envelope_from TEXT NOT NULL, envelope_to_normalized TEXT NOT NULL, raw_sha256 TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT, expires_at INTEGER NOT NULL,
  PRIMARY KEY(envelope_from,envelope_to_normalized,raw_sha256)
);
CREATE INDEX idx_dedup_expiry ON receive_dedup(expires_at);
CREATE TABLE job_leases (job_name TEXT PRIMARY KEY, lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL);
CREATE TABLE auth_rate_limits (
  bucket_key TEXT NOT NULL, window_started_at INTEGER NOT NULL, failures INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(bucket_key,window_started_at)
);
CREATE INDEX idx_rate_expiry ON auth_rate_limits(expires_at);
CREATE TABLE maintenance_state (
  key TEXT PRIMARY KEY, value_text TEXT, value_int INTEGER, updated_at INTEGER NOT NULL
);
