import { Pool } from 'pg';
import { dbConfig } from '../../config/appConfig.js';

export const pgPool = new Pool({
  connectionString: dbConfig.connectionString
});

export const shutdownDb = async () => {
  await pgPool.end();
};
