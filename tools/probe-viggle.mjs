import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Official response contract: https://docs.viggle.ai/v1/api-reference/credits
// GET /v1/credits -> { balance: number }. Never create assets or spend credits.
export const CREDITS_URL = 'https://apis.viggle.ai/v1/credits';
export const TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const EXPECTED_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SAFE_FAILURES = new Set([
  'UNSUPPORTED_ARGUMENTS', 'WORKSPACE_PATH_REJECTED', 'OUTPUT_WRITE_FAILED',
]);

function fail(code) {
  const error = new Error(code);
  error.safeCode = code;
  throw error;
}

function samePath(a, b) {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(path.resolve(a)) === normalize(path.resolve(b));
}

function assertNoLinks(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const info = fs.lstatSync(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) fail('WORKSPACE_PATH_REJECTED');
  }
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function outputDirectory() {
  try {
    assertNoLinks(EXPECTED_ROOT);
    const root = fs.realpathSync(EXPECTED_ROOT);
    if (!samePath(root, EXPECTED_ROOT) || !samePath(process.cwd(), root)) fail('WORKSPACE_PATH_REJECTED');
    const expectedScript = path.join(root, 'tools', 'probe-viggle.mjs');
    const actualScript = fileURLToPath(import.meta.url);
    if (!samePath(actualScript, expectedScript) || fs.lstatSync(actualScript).isSymbolicLink()
      || !samePath(fs.realpathSync(actualScript), expectedScript)) fail('WORKSPACE_PATH_REJECTED');
    let directory = root;
    for (const name of ['game', 'local', 'workflow-spike', 'preflight']) {
      directory = path.join(directory, name);
      if (!contained(root, directory)) fail('WORKSPACE_PATH_REJECTED');
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
      assertNoLinks(directory);
      if (!samePath(fs.realpathSync(directory), directory)) fail('WORKSPACE_PATH_REJECTED');
    }
    return { root, directory };
  } catch (error) {
    if (error?.safeCode === 'WORKSPACE_PATH_REJECTED') throw error;
    fail('WORKSPACE_PATH_REJECTED');
  }
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch { /* Do not log server or network detail. */ }
}

async function readBalance(response) {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await cancelBody(response);
    return { errorCode: 'INVALID_RESPONSE' };
  }
  const declaredSize = response.headers.get('content-length');
  if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_RESPONSE_BYTES)) {
    await cancelBody(response);
    return { errorCode: 'RESPONSE_LIMIT_EXCEEDED' };
  }
  if (!response.body) return { errorCode: 'INVALID_RESPONSE' };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return { errorCode: 'RESPONSE_LIMIT_EXCEEDED' };
      }
      chunks.push(Buffer.from(value));
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || Array.isArray(value) || typeof value.balance !== 'number' || !Number.isFinite(value.balance)) {
      return { errorCode: 'INVALID_RESPONSE' };
    }
    // Only this documented numeric field is permitted out of the response body.
    return { balance: value.balance };
  } catch {
    return { errorCode: 'INVALID_RESPONSE' };
  } finally {
    reader.releaseLock();
  }
}

export async function probeViggle({ online = false, env = process.env, request = globalThis.fetch } = {}) {
  const startedAt = new Date().toISOString();
  const credential = typeof env.VIGGLE_API_KEY === 'string' ? env.VIGGLE_API_KEY.trim() : '';
  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt: null,
    mode: online ? 'online-read-only-credits' : 'offline-preflight',
    status: 'PENDING',
    credentialPresent: Boolean(credential),
    serviceVerified: false,
    endpoint: CREDITS_URL,
    method: 'GET',
    networkRequests: 0,
    generationRequests: 0,
    httpStatus: null,
    balance: null,
    errorCode: null,
  };
  if (!credential) report.errorCode = 'MISSING_API_KEY';
  else if (!online) report.errorCode = 'ONLINE_NOT_REQUESTED';
  else {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      report.networkRequests = 1;
      const response = await request(CREDITS_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential}` },
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
      });
      report.httpStatus = response.status;
      if (response.status >= 300 && response.status <= 399) {
        report.errorCode = 'REDIRECT_REJECTED';
        await cancelBody(response);
      } else if (response.status !== 200) {
        report.errorCode = 'HTTP_ERROR';
        await cancelBody(response);
      } else {
        const result = await readBalance(response);
        if (controller.signal.aborted) report.errorCode = 'TIMEOUT';
        else if (result.errorCode) report.errorCode = result.errorCode;
        else {
          report.balance = result.balance;
          report.status = 'VERIFIED';
          report.serviceVerified = true;
        }
      }
    } catch {
      report.errorCode = controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR';
    } finally {
      clearTimeout(timeout);
    }
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

async function main(args) {
  if (!(args.length === 0 || (args.length === 1 && args[0] === '--online'))) fail('UNSUPPORTED_ARGUMENTS');
  // Validate the fixed workspace and output path before any possible request.
  const { root, directory } = outputDirectory();
  const report = await probeViggle({ online: args.length === 1 });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const filename = path.join(directory, `viggle-preflight-${stamp}-${randomUUID().slice(0, 8)}.json`);
  if (!contained(directory, filename)) fail('WORKSPACE_PATH_REJECTED');
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {
    fail('OUTPUT_WRITE_FAILED');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  process.stdout.write(`${JSON.stringify({ report: path.relative(root, filename).replaceAll('\\', '/'), ...report })}\n`);
  // PENDING is expected for an offline or missing-key check. It never verifies the service.
  if (args.length === 1 && report.credentialPresent && !report.serviceVerified) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const errorCode = SAFE_FAILURES.has(error?.safeCode) ? error.safeCode : 'INTERNAL_ERROR';
    process.stderr.write(`${JSON.stringify({ status: 'ERROR', errorCode })}\n`);
    process.exitCode = 1;
  });
}
