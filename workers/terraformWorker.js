import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'bullmq';
import { runCommand } from '../lib/runCommand.js';
import { readFile, writeFile } from 'node:fs/promises';
import { sanitizeSettingsInput, defaultTerraformSettings } from '../lib/terraformSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const terraformDir = path.resolve(__dirname, '../terraform');
const terraformVarsPath = path.resolve(__dirname, '../config/terraform-settings.json');
const sanitizedVarsPath = path.resolve(terraformDir, '.terraform-vars.json');

export const terraformQueueName = 'terraform-workflows';

export function startTerraformWorker(connection) {
  return new Worker(
    terraformQueueName,
    async job => {
      const env = {
        ...process.env,
        TF_IN_AUTOMATION: '1',
        TF_DATA_DIR: path.join(terraformDir, '.terraform')
      };
      let preparedVarFile;
      try {
        const raw = await readFile(terraformVarsPath, 'utf8');
        const rawSettings = JSON.parse(raw);
        const sanitized = sanitizeSettingsInput(rawSettings);
        const merged = { ...defaultTerraformSettings, ...sanitized };
        await writeFile(sanitizedVarsPath, JSON.stringify(merged, null, 2));
        preparedVarFile = sanitizedVarsPath;
      } catch (err) {
        throw new Error(
          `Unable to prepare terraform vars (looked at ${terraformVarsPath}): ${err.message}`
        );
      }

      await runCommand('terraform', ['init', '-input=false'], { cwd: terraformDir, env });
      const planOutput = await runCommand(
        'terraform',
        ['plan', '-out=tfplan', '-input=false', `-var-file=${preparedVarFile}`],
        { cwd: terraformDir, env }
      );
      await runCommand(
        'terraform',
        ['apply', '-auto-approve', 'tfplan'],
        { cwd: terraformDir, env }
      );

      return {
        planOutput,
        labInstanceId: job.data.labInstanceId,
        runId: job.data.runId
      };
    },
    { connection, concurrency: 1 }
  );
}
