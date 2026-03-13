ALTER TABLE vm_templates
  ADD COLUMN IF NOT EXISTS os_type TEXT;

UPDATE vm_templates
SET os_type = CASE
  WHEN LOWER(name) LIKE '%windows 11%' THEN 'windows11'
  WHEN LOWER(name) LIKE '%windows%' THEN 'windows-server'
  WHEN LOWER(name) LIKE '%ubuntu%' THEN 'ubuntu'
  ELSE 'ubuntu'
END
WHERE os_type IS NULL;

ALTER TABLE vm_templates
  ALTER COLUMN os_type SET DEFAULT 'ubuntu';

ALTER TABLE vm_templates
  ALTER COLUMN os_type SET NOT NULL;

