import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { projectPath, compressUuid, checkConfig } from './bootstrap-game.mjs';
import { createStaticServer, resolveRequest } from './serve.mjs';
import { assertPreparedBuild, artifactContainsBuildId } from './check-game.mjs';

test('build provenance rejects changed inputs, identity, target and missing compiled ID', () => {
  const prepared = { target: 'web-desktop', nonce: 'build-one', revision: 'abc123', preparedAt: '2026-11-06T00:00:00Z',
    buildId: 'P1-abc123-12345678-20261106T000000Z', sourceDigest: 'full-original', fingerprint: 'input-original' };
  const current = { buildId: prepared.buildId, sourceDigest: prepared.sourceDigest, fingerprint: prepared.fingerprint };
  assert.doesNotThrow(() => assertPreparedBuild('web-desktop', prepared, current, true));
  assert.throws(() => assertPreparedBuild('web-desktop', prepared, { ...current, fingerprint: 'edited-script', sourceDigest: 'edited-full' }, true), /inputs changed/);
  assert.throws(() => assertPreparedBuild('web-desktop', prepared, { ...current, sourceDigest: 'new-imported-meta' }, true), /inputs changed/);
  assert.throws(() => assertPreparedBuild('web-desktop', prepared, { ...current, buildId: 'other-build' }, true), /BuildInfo changed/);
  assert.throws(() => assertPreparedBuild('web-desktop', prepared, current, false), /Compiled JavaScript/);
  assert.throws(() => assertPreparedBuild('wechatgame', prepared, current, true), /snapshot/);
});

test('compiled identity must be an exact literal in JavaScript, not manifest or source map', () => {
  const root = projectPath(`game/local/tooling-tests/identity-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const id = 'P1-abc123-12345678-20261106T000000Z';
  fs.writeFileSync(path.join(root, 'build-manifest.json'), JSON.stringify({ buildId: id }));
  fs.writeFileSync(path.join(root, 'bundle.js.map'), JSON.stringify({ sourcesContent: [id] }));
  fs.writeFileSync(path.join(root, 'bundle.js'), `const build = "${id}-wrong";`);
  assert.equal(artifactContainsBuildId(root, id), false);
  fs.writeFileSync(path.join(root, 'bundle.js'), `const build = '${id}';`);
  assert.equal(artifactContainsBuildId(root, id), true);
});

test('project and official Cocos UUID example agree', () => {
  assert.equal(checkConfig().scriptType, '74264tw6btLiJ6u3awUqhww');
  assert.equal(compressUuid('7bf9df40-4bc9-4e25-8cb0-9a500f949102'), '7bf9d9AS8lOJYywmlAPlJEC');
  assert.throws(() => projectPath('../other-game'), /Outside project/);
});

test('local static server serves files and rejects traversal/method abuse', async () => {
  const root = projectPath(`game/local/tooling-tests/run-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<p>server test fixture</p>');
  const server = createStaticServer(root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (requestPath, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: requestPath, method }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.equal((await request('/')).status, 200);
    assert.equal((await request('/?v=1')).status, 200);
    assert.equal((await request('/', 'HEAD')).body, '');
    assert.equal((await request('/', 'POST')).status, 405);
    for (const unsafe of ['/../package.json', '/%2e%2e/package.json', '/%2e%2e%5cpackage.json', '/C:/Windows', '/%00', '/%zz']) {
      assert.equal((await request(unsafe)).status, 403, unsafe);
    }
    assert.equal((await request('/missing')).status, 404);
    assert.equal(resolveRequest(root, '/index.html'), path.join(root, 'index.html'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
