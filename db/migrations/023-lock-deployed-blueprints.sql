CREATE OR REPLACE FUNCTION prevent_deployed_blueprint_modification()
RETURNS trigger AS $$
DECLARE
  locked BOOLEAN := FALSE;
BEGIN
  IF TG_TABLE_NAME = 'lab_blueprints' THEN
    SELECT EXISTS (
      SELECT 1
        FROM lab_deployments
       WHERE blueprint_id IN (OLD.id, NEW.id)
    )
      INTO locked;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
        FROM lab_deployments
       WHERE blueprint_id = NEW.blueprint_id
    )
      INTO locked;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT EXISTS (
      SELECT 1
        FROM lab_deployments
       WHERE blueprint_id = OLD.blueprint_id
    )
      INTO locked;
  ELSE
    SELECT EXISTS (
      SELECT 1
        FROM lab_deployments
       WHERE blueprint_id IN (OLD.blueprint_id, NEW.blueprint_id)
    )
      INTO locked;
  END IF;

  IF locked THEN
    RAISE EXCEPTION 'blueprint is locked because it is used by an existing deployment'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_deployed_blueprint_update ON lab_blueprints;
CREATE TRIGGER prevent_deployed_blueprint_update
  BEFORE UPDATE ON lab_blueprints
  FOR EACH ROW
  EXECUTE FUNCTION prevent_deployed_blueprint_modification();

DROP TRIGGER IF EXISTS prevent_deployed_blueprint_vm_change ON lab_blueprint_vms;
CREATE TRIGGER prevent_deployed_blueprint_vm_change
  BEFORE INSERT OR UPDATE OR DELETE ON lab_blueprint_vms
  FOR EACH ROW
  EXECUTE FUNCTION prevent_deployed_blueprint_modification();
