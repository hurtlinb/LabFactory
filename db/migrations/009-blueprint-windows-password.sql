ALTER TABLE lab_blueprints
  ADD COLUMN IF NOT EXISTS windows_admin_password TEXT NOT NULL DEFAULT '';
