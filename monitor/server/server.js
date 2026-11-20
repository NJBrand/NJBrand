import fs from 'node:fs';
import { format } from 'node:util';
import { startServer } from './app.js';

// LOG_FILE: append console output to a file (used on Windows, where the server runs as a background
// task with no console). Rotated at startup once it passes 5 MB, keeping one old copy.
if (process.env.LOG_FILE) {
  const file = process.env.LOG_FILE;
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.old`);
  } catch {}
  const write = (level) => (...args) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${format(...args)}\n`);
    } catch {}
  };
  console.log = write('INFO');
  console.info = write('INFO');
  console.warn = write('WARN');
  console.error = write('ERROR');
  process.on('uncaughtException', (e) => {
    console.error('Uncaught:', e);
    process.exit(1);
  });
}

const app = await startServer().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
console.log(`IT monitor listening on ${app.url} (${app.config.devices.length} devices configured)`);
const stop = async () => {
  await app.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
