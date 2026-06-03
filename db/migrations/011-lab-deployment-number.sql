CREATE SEQUENCE IF NOT EXISTS lab_deployment_number_seq;

ALTER TABLE lab_deployments
  ADD COLUMN IF NOT EXISTS deployment_number BIGINT;

ALTER TABLE lab_deployments
  ALTER COLUMN deployment_number SET DEFAULT nextval('lab_deployment_number_seq');

WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS deployment_number
  FROM lab_deployments
  WHERE deployment_number IS NULL
)
UPDATE lab_deployments d
SET deployment_number = numbered.deployment_number
FROM numbered
WHERE d.id = numbered.id;

SELECT setval(
  'lab_deployment_number_seq',
  GREATEST((SELECT COALESCE(MAX(deployment_number), 0) FROM lab_deployments), 1),
  true
);

ALTER TABLE lab_deployments
  ALTER COLUMN deployment_number SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS lab_deployments_deployment_number_idx
  ON lab_deployments (deployment_number);
