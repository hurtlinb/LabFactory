import * as pino from 'pino';
import { appConfig } from '../../config/appConfig.js';
const pinoFactory = pino;
const createLogger = pinoFactory.default ?? pinoFactory;
export const logger = createLogger({
    level: appConfig.logLevel,
    base: { service: 'lab-orchestrator' },
    timestamp: pino.stdTimeFunctions.isoTime
});
