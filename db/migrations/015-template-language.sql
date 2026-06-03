ALTER TABLE vm_templates
ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';

UPDATE vm_templates
SET language = 'en'
WHERE COALESCE(BTRIM(language), '') = '';

ALTER TABLE vm_templates
DROP CONSTRAINT IF EXISTS vm_templates_language_check;

ALTER TABLE vm_templates
ADD CONSTRAINT vm_templates_language_check CHECK (language IN ('fr', 'en'));
