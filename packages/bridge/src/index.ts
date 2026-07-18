/**
 * Dev entry (`npm run dev` → tsx watch). Starts the bridge with the demo
 * adapter available (POST /demo/start — not auto-run) and the transcript
 * adapter only when VW_WATCH_CLAUDE=1. Recording via VW_RECORD=1.
 */
import { startServer } from './server.js';
import { SERVER_VERSION } from './version.js';

const server = await startServer({
  record: process.env.VW_RECORD === '1',
  watchClaude: process.env.VW_WATCH_CLAUDE === '1',
});

console.log(`visual-workflows bridge ${SERVER_VERSION} (dev)`);
console.log(`  dashboard  ${server.url}`);
console.log(`  websocket  ws://127.0.0.1:${server.port}/ws`);
console.log(`  data dir   ${server.dataDir}`);
console.log('  demo       POST /demo/start (or click ▶ in the UI)');

const shutdown = () => {
  server.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server };
