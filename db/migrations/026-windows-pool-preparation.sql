ALTER TABLE vm_pool DROP CONSTRAINT vm_pool_status_check;
ALTER TABLE vm_pool ADD CONSTRAINT vm_pool_status_check
  CHECK (status IN ('creating', 'preparing', 'ready', 'assigned', 'error'));
ALTER TABLE vm_pool
  ADD COLUMN preparation_started_at TIMESTAMPTZ,
  ADD COLUMN prepared_at TIMESTAMPTZ,
  ADD COLUMN guest_probe_pid BIGINT;

-- Cold Windows inventory from the previous implementation must boot before reuse.
UPDATE vm_pool p SET status = 'preparing', preparation_started_at = NOW()
FROM vm_templates t
WHERE p.template_id = t.id AND p.status = 'ready'
  AND t.os_type IN ('windows11', 'windows-server');
