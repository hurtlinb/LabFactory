ALTER TABLE classrooms
  ADD COLUMN IF NOT EXISTS starting_subnet TEXT;

UPDATE classrooms
SET starting_subnet = CONCAT('10.0.', COALESCE(starting_subnet_octet, starting_vlan), '.0')
WHERE starting_subnet IS NULL;

ALTER TABLE classrooms
  ALTER COLUMN starting_subnet SET DEFAULT '10.0.200.0';

ALTER TABLE classrooms
  ALTER COLUMN starting_subnet SET NOT NULL;
