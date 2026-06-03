ALTER TABLE lab_deployments
  DROP CONSTRAINT IF EXISTS lab_deployments_blueprint_id_fkey;

ALTER TABLE lab_deployments
  ADD CONSTRAINT lab_deployments_blueprint_id_fkey
  FOREIGN KEY (blueprint_id) REFERENCES lab_blueprints(id) ON DELETE RESTRICT;
