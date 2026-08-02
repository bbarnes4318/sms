/**
 * Boots the REAL server.js as a child process against a throwaway database and
 * returns an authenticated HTTP client. Nothing here mocks the application.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.resolve(__dirname, '..', '..', 'server.js');

function findFreePort() {
  // Ports are picked from a high range; a collision just fails the boot wait.
  return 4700 + Number(process.hrtime.bigint() % 200n);
}

async function startServer({ label = 'api', env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sms-server-${label}-`));
  const dbFile = path.join(dir, 'test.sqlite');
  const port = findFreePort();

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      SMS_DB_PATH: dbFile,
      PORT: String(port),
      NODE_ENV: 'test',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logs = [];
  const errors = [];
  child.stdout.on('data', d => logs.push(d.toString()));
  child.stderr.on('data', d => { errors.push(d.toString()); logs.push(d.toString()); });

  const base = `http://127.0.0.1:${port}`;

  // Wait for the port to answer.
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode}):\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`${base}/api/auth/status`);
      if (res.ok) break;
    } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(`server did not start in time:\n${logs.join('')}`);
    }
    await new Promise(r => setTimeout(r, 120));
  }

  let cookie = '';

  async function request(method, url, body, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && cookie) headers.Cookie = cookie;
    const res = await fetch(`${base}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* html or plain text */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  return {
    base,
    port,
    dbFile,
    logs,
    errors,
    get serverErrors() {
      // Ignore the expected websocket/carrier noise of a test environment.
      return errors.filter(e => !/ECONNREFUSED|FracTEL|BulkVS|carrier/i.test(e));
    },
    request,
    get: (url, opts) => request('GET', url, undefined, opts),
    post: (url, body, opts) => request('POST', url, body, opts),
    del: (url, opts) => request('DELETE', url, undefined, opts),
    async signup(username = 'tester', password = 'test-password-123') {
      return request('POST', '/api/auth/signup', { username, password }, { auth: false });
    },
    async login(username = 'tester', password = 'test-password-123') {
      return request('POST', '/api/auth/login', { username, password }, { auth: false });
    },
    clearCookie() { cookie = ''; },
    async stop() {
      child.kill();
      await new Promise(r => { child.on('exit', r); setTimeout(r, 2000); });
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  };
}

module.exports = { startServer };
