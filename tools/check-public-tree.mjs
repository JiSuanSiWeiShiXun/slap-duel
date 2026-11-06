import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const staged = process.argv.includes('--staged');
if (process.argv.slice(2).some(arg => arg !== '--staged')) throw new Error('Usage: node tools/check-public-tree.mjs [--staged]');
const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
const allowed = /^(?:\.gitignore|README\.md|package\.json|tsconfig\.rules\.json|docs\/public\/[A-Za-z0-9-]+\.md|tests\/[A-Za-z0-9.-]+\.cjs|tools\/[A-Za-z0-9.-]+\.(?:mjs|ps1)|game\/(?:assets|build-config|build-templates|settings)\/.+|game\/(?:package|tsconfig)\.json)$/;
const blocked = /(?:^|\/)(?:\.planning|\.notion-pm-private|node_modules|library|temp|local|profiles|build|\.ssh)(?:\/|$)|(?:^|\/)(?:AGENTS\.md|project\.private\.config\.json|information\.json|verify-evidence\.mjs)$|\.(?:pem|key|p12|pfx|png|jpe?g|zip|gz)$/i;
const detectors = [
  ['private-key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['cloud-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['service-token', /\b(?:secret_|ntn_)[A-Za-z0-9]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
  ['credential-assignment', /(?:password|appsecret|access[_-]?token|api[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_+\/-]{16,}["']/i],
  ['private-workspace-path', /[A-Z]:[\\/](?:Users|seasun)[\\/][^\s"'<>]+/i],
  ['private-notion-link', /https?:\/\/(?:app\.)?notion\.(?:com|so)\//i],
  ['account-form-session', /https?:\/\/[^\s"']+[?&](?:sid|token|access_token)=[A-Za-z0-9_-]{12,}/i],
];
const findings = [];
for (const file of files) {
  if (!allowed.test(file) || blocked.test(file)) { findings.push({ file, category: 'nonpublic-path' }); continue; }
  const bytes = staged ? execFileSync('git', ['show', `:${file}`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }) : fs.readFileSync(path.join(root, file));
  if (bytes.includes(0)) { findings.push({ file, category: 'unreviewed-binary' }); continue; }
  const text = bytes.toString('utf8');
  for (const [category, expression] of detectors) if (expression.test(text)) findings.push({ file, category });
  for (const match of text.matchAll(/\bwx[0-9a-f]{16}\b/gi)) {
    // Repeated-digit fixtures are deliberately non-account examples in config tests.
    if (new Set(match[0].slice(2).toLowerCase()).size > 1) findings.push({ file, category: 'wechat-account-identity' });
  }
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const octets = match[0].split('.').map(Number);
    if (octets.every(n => n <= 255) && !match[0].startsWith('127.') && match[0] !== '0.0.0.0') findings.push({ file, category: 'server-address' });
  }
}
if (!files.length) findings.push({ file: '<index>', category: 'empty-tree' });
console.log(JSON.stringify({ passed: findings.length === 0, scope: staged ? 'staged-public-tree' : 'tracked-working-tree', files: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
