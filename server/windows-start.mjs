import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { format } from 'node:util';

const dataDir = resolve(process.env.DATA_DIR ?? './data');
mkdirSync(dataDir, { recursive: true });
const logPath = join(dataDir, 'server.log');
function log(level, values) {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${level} ${format(...values)}\n`);
}
console.log = (...values) => log('INFO', values);
console.warn = (...values) => log('WARN', values);
console.error = (...values) => log('ERROR', values);
process.on('warning', warning => console.warn(warning.stack ?? warning.message));
process.on('uncaughtException', error => { console.error(error); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error); process.exit(1); });
try {
  await import('./index.mjs');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
