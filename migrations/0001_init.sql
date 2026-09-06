CREATE TABLE IF NOT EXISTS cameras (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Untitled camera',
  status TEXT NOT NULL DEFAULT 'waiting',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted')),
  token_hash TEXT NOT NULL,
  max_viewers INTEGER NOT NULL DEFAULT 4,
  relay_only INTEGER NOT NULL DEFAULT 0,
  bitrate_kbps INTEGER NOT NULL DEFAULT 900,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cameras_public_recent
ON cameras(visibility, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  remote_hash TEXT,
  FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reports_camera ON reports(camera_id, created_at DESC);
