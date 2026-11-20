import { startServer } from './app.js';

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
