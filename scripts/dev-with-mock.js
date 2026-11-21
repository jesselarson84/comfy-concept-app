// dev-with-mock.js - run the mock ComfyUI and the app together (no GPU needed).
import { createMockComfy } from '../test/mock-comfy.js';
import { createApp } from '../server/index.js';
import { loadConfig } from '../server/config.js';
const mockPort = Number(process.env.MOCK_PORT || 18188);
createMockComfy().server.listen(mockPort, '127.0.0.1', () => {
  const cfg = loadConfig({ comfyUrl: `http://127.0.0.1:${mockPort}`, dataDir: process.env.DATA_DIR || 'data-mock' });
  createApp(cfg).server.listen(cfg.port, cfg.host, () => console.log(`App http://${cfg.host}:${cfg.port}/  ->  mock ComfyUI ${cfg.comfyUrl}`));
});
