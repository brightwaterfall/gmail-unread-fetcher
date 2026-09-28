/**
 * Registers a resolve hook so `import 'googleapis'` is replaced by the fake
 * during `npm test`. Loaded via: node --import ./mock-register.js mock-test.js
 */
import { register } from 'node:module';

register('./mock-loader.js', import.meta.url);
