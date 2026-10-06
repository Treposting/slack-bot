// Zips the built extension as slack-cleaner-v<version>.zip, ready to attach
// to a GitHub release. Run `npm run package` (it builds first).
import { readFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const { version } = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
const out = `dist/slack-cleaner-v${version}.zip`;
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/slack-cleaner', { recursive: true });
cpSync('extension', 'dist/slack-cleaner', { recursive: true });
execFileSync('zip', ['-qr', `slack-cleaner-v${version}.zip`, 'slack-cleaner'], { cwd: 'dist' });
rmSync('dist/slack-cleaner', { recursive: true });
console.log(`Wrote ${out}`);
