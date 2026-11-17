// `next start` on $PORT (Render/most PaaS inject it), defaulting to 3700 for local use. Cross-platform (no shell syntax).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nextBin = require.resolve('next/dist/bin/next');
const port = process.env.PORT || '3700';
const child = spawn(process.execPath, [nextBin, 'start', '-p', port], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
