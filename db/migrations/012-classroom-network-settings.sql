ALTER TABLE classrooms
  ADD COLUMN IF NOT EXISTS network_vlan_gateway_host_offset INTEGER NOT NULL DEFAULT 1;

ALTER TABLE classrooms
  ADD COLUMN IF NOT EXISTS network_vlan_mask TEXT NOT NULL DEFAULT '/24';
