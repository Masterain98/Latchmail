CREATE TABLE webhook_request_snapshots (
  id TEXT PRIMARY KEY,
  delivery_id TEXT UNIQUE,
  payload_object_key TEXT NOT NULL,
  raw_object_key TEXT NOT NULL,
  raw_filename TEXT NOT NULL,
  payload_size_bytes INTEGER NOT NULL,
  raw_size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  capture_error_code TEXT,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  cleanup_next_attempt_at INTEGER,
  cleanup_error_code TEXT
);
CREATE INDEX idx_webhook_snapshots_expiry
  ON webhook_request_snapshots(expires_at,cleanup_next_attempt_at);

CREATE TABLE webhook_send_records (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES webhook_request_snapshots(id) ON DELETE RESTRICT,
  delivery_id TEXT,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('email','test')),
  attempt_number INTEGER NOT NULL,
  endpoint_url TEXT NOT NULL,
  request_headers_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result TEXT NOT NULL CHECK(result IN ('started','succeeded','retry','failed','interrupted')),
  http_status INTEGER,
  duration_ms INTEGER,
  error_code TEXT,
  response_object_key TEXT,
  response_content_type TEXT,
  response_captured_bytes INTEGER NOT NULL DEFAULT 0,
  response_truncated INTEGER NOT NULL DEFAULT 0 CHECK(response_truncated IN (0,1)),
  response_excerpt TEXT,
  expires_at INTEGER NOT NULL,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  cleanup_next_attempt_at INTEGER,
  cleanup_error_code TEXT
);
CREATE INDEX idx_webhook_records_cursor
  ON webhook_send_records(started_at DESC,id DESC);
CREATE INDEX idx_webhook_records_expiry
  ON webhook_send_records(expires_at,cleanup_next_attempt_at);
CREATE INDEX idx_webhook_records_delivery
  ON webhook_send_records(delivery_id,started_at DESC);
