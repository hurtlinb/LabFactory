import * as pino from 'pino';
import { appConfig } from '../../config/appConfig.js';

type PinoFactory = {
  (options?: pino.LoggerOptions, stream?: pino.DestinationStream): pino.Logger;
  default?: PinoFactory;
};

const pinoFactory = pino as unknown as PinoFactory;
const createLogger = pinoFactory.default ?? pinoFactory;

export const logger = createLogger({
  level: appConfig.logLevel,
  base: { service: 'lab-orchestrator' },
  timestamp: pino.stdTimeFunctions.isoTime
});
