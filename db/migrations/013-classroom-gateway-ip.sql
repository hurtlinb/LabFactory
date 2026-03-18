ALTER TABLE classrooms
  ADD COLUMN IF NOT EXISTS network_gateway TEXT;

UPDATE classrooms
SET network_gateway = CONCAT(
  SPLIT_PART(starting_subnet, '.', 1), '.',
  SPLIT_PART(starting_subnet, '.', 2), '.',
  SPLIT_PART(starting_subnet, '.', 3), '.',
  GREATEST(1, COALESCE(network_vlan_gateway_host_offset, 1))
)
WHERE network_gateway IS NULL OR BTRIM(network_gateway) = '';

ALTER TABLE classrooms
  ALTER COLUMN network_gateway SET NOT NULL;
