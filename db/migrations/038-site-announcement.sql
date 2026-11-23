-- Site-wide announcement banner (maintenance, outage...), configured from the Maintenance page
-- and shown on every page of the dashboard. Single row (id = TRUE).
-- Idempotent (the migration runner may replay every file).
CREATE TABLE IF NOT EXISTS site_announcement (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'danger')),
  message TEXT NOT NULL DEFAULT '' CHECK (char_length(message) <= 500),
  ends_at TIMESTAMPTZ,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT site_announcement_enabled_message CHECK (NOT enabled OR char_length(btrim(message)) > 0)
);

INSERT INTO site_announcement (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
