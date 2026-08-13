// Hermes dashboard.
//
//   npm run web            http://127.0.0.1:4317
//   PORT=8080 npm run web
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createEventHub } from './events.js';
import { createRunner } from './runner.js';
import { startServer } from './server.js';

dotenv.config();

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(projectDir, '.hermes');
const storyDir = process.env.STORY_OUT_DIR || path.join(projectDir, 'out');
const port = Number(process.env.PORT) || 4317;

const hub = createEventHub();
const runner = createRunner({ projectDir, dataDir, hub });

startServer({ port, projectDir, dataDir, storyDir, runner, hub })
  .then(() => {
    console.log(`Hermes dashboard  →  http://127.0.0.1:${port}`);
    console.log(`Stories from      →  ${storyDir}`);
  })
  .catch(error => {
    console.error(`\n❌ ${error.message}`);
    process.exit(1);
  });
