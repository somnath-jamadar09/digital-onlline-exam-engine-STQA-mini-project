'use strict';
const { openDb } = require('./db');
const { createApp } = require('./app');
const { seedDemo } = require('./seed');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || ':memory:';
const GRACE_MS = process.env.GRACE_MS ? Number(process.env.GRACE_MS) : 2000;

const db = openDb(DB_PATH);
const engine = createApp({ db, graceMs: GRACE_MS });
if (process.env.SEED !== '0') seedDemo(db);
engine.startSweeper(Number(process.env.SWEEP_MS) || 1000);

const server = engine.app.listen(PORT, () => {
  console.log(`exam-engine listening on http://localhost:${PORT} (db=${DB_PATH}, grace=${GRACE_MS}ms)`);
});
server.keepAliveTimeout = 65000;

function shutdown() {
  engine.stopSweeper();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
