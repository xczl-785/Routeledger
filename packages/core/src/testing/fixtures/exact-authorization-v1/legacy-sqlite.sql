-- Minimal v1 authority-store evidence. EA2 owns executable migration DDL.
CREATE TABLE l3_authorization_grants (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  operation_digest TEXT,
  allowed_actions_json TEXT NOT NULL,
  allowed_target_ids_json TEXT NOT NULL,
  session_id TEXT,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL,
  status TEXT NOT NULL
);
INSERT INTO l3_authorization_grants VALUES
  ('grant-operation-active','operation','digest-operation','["start_version"]','["version-1"]','session-legacy','2026-08-12T01:00:00.000Z',1,0,'active'),
  ('grant-session-active','session',NULL,'["start_version","close_version"]','["version-1","version-2"]','session-legacy','2026-08-12T01:00:00.000Z',4,1,'active'),
  ('grant-window-active','time_window',NULL,'["advance_to_version"]','["version-2"]',NULL,'2026-08-12T01:00:00.000Z',8,2,'active');
