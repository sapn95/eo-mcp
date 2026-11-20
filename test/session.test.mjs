// The session: what a logged-out portal looks like from here, the login, the
// cache that carries a session across a restart, and attaching to a browser
// that is already running.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startServer } from './client.mjs';
import { startPortal, ID, COOKIE } from './fixture-portal.mjs';

// A browser to play "the one that is already running": Playwright's own where
// it is installed, as on CI, and otherwise a Chrome that is on the machine.
const someBrowser = () => [
  (() => { try { return chromium.executablePath(); } catch { return ''; } })(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
].find(p => p && existsSync(p));

const cleanup = [];
after(async () => { for (const f of cleanup.reverse()) await f().catch(() => {}); });
const portalWith = async o => { const p = await startPortal(o); cleanup.push(() => p.close()); return p; };
const serverWith = async env => { const s = await startServer(env, { timeout: 60000 }); cleanup.push(() => s.stop()); return s; };

describe('logged out', () => {
  for (const loggedOut of ['redirect', '401', 'html']) {
    test(`a portal that answers a stranger with ${loggedOut} is reported as login_required by every tool`, async () => {
      const portal = await portalWith({ loggedOut });
      const srv = await serverWith({ EO_BASE_URL: portal.url });
      assert.deepEqual((await srv.call('eo_status')).data, { status: 'login_required' });
      const calls = [
        ['eo_list_periods', {}], ['eo_get_form', { business_id: ID }],
        ['eo_update_form', { business_id: ID, changes: { isServicePeriodValidated: true } }],
        ['eo_search_employers', { name: 'x' }], ['eo_compensation_offices', {}],
        ['eo_register', { code: '11111111-1111-4111-8111-111111111111' }],
        ['eo_delete_attachment', { business_id: ID, attachment_id: '1' }],
        ['eo_submit', { business_id: ID, confirm: true }],
      ];
      for (const [name, args] of calls) {
        const { data, isError } = await srv.call(name, args);
        assert.equal(data.status, 'login_required', name);
        assert.match(data.message, /eo_login/, name);
        assert.ok(!isError, name);
      }
      // Nothing was cached for a session that does not exist.
      assert.ok(!existsSync(join(srv.scratch, 'state.json')));
      assert.equal(portal.requests.filter(r => r.authed).length, 0);
    });
  }
});

describe('login', () => {
  test('a login somebody finishes is reported ok and cached, readable by its owner only', async () => {
    const portal = await portalWith({ autoLoginAfterMs: 300 });
    const srv = await serverWith({ EO_BASE_URL: portal.url, EO_LOGIN_POLL_MS: '150', EO_LOGIN_TIMEOUT_MS: '20000' });
    const { data } = await srv.call('eo_login');
    assert.equal(data.status, 'ok');
    assert.equal(data.session_cache, 'saved');
    assert.match(data.message, /state\.json gespeichert/);
    const file = join(srv.scratch, 'state.json');
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).cookies.some(c => c.name === COOKIE));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(srv.scratch + '/profile').mode & 0o777, 0o700);
    assert.equal((await srv.call('eo_list_periods')).data.periods.length, 2);

    // And the cache is what a restart lives on: a second server on a fresh
    // profile, handed nothing but the state file, is logged in.
    await srv.stop();
    const again = await serverWith({ EO_BASE_URL: portal.url, EO_STATE: file, EO_PROFILE: '' });
    assert.deepEqual((await again.call('eo_status')).data, { status: 'ok' });
  });

  test('a login nobody finishes is login_required, and nothing is cached', async () => {
    const portal = await portalWith();
    const srv = await serverWith({ EO_BASE_URL: portal.url, EO_LOGIN_POLL_MS: '100', EO_LOGIN_TIMEOUT_MS: '700' });
    const { data } = await srv.call('eo_login');
    assert.equal(data.status, 'login_required');
    assert.match(data.message, /nicht abgeschlossen/);
    assert.ok(!existsSync(join(srv.scratch, 'state.json')));
    // It asked more than once before giving up.
    assert.ok(portal.calls('GET', /\/cases$/).length >= 2);
  });

  test('with the cache switched off the login says the session will not survive', async () => {
    const portal = await portalWith({ autoLoginAfterMs: 200 });
    const srv = await serverWith({ EO_BASE_URL: portal.url, EO_STATE: '', EO_LOGIN_POLL_MS: '150', EO_LOGIN_TIMEOUT_MS: '20000' });
    const { data } = await srv.call('eo_login');
    assert.equal(data.status, 'ok');
    assert.equal(data.session_cache, 'disabled');
    assert.match(data.message, /NICHT zwischengespeichert/);
  });

  test('a cache that cannot be written is said to have failed', async () => {
    const portal = await portalWith({ autoLoginAfterMs: 200 });
    // A path below a regular file can never be created.
    const srv = await serverWith({ EO_BASE_URL: portal.url, EO_STATE: '/dev/null/state.json', EO_LOGIN_POLL_MS: '150', EO_LOGIN_TIMEOUT_MS: '20000' });
    const { data } = await srv.call('eo_login');
    assert.equal(data.status, 'ok');
    assert.equal(data.session_cache, 'failed');
    assert.match(data.message, /konnte nicht gespeichert werden/);
  });

  test('a login to an account that is not registered yet went through, and says what comes next', async () => {
    const portal = await portalWith({ autoLoginAfterMs: 200, registered: false });
    const srv = await serverWith({ EO_BASE_URL: portal.url, EO_LOGIN_POLL_MS: '150', EO_LOGIN_TIMEOUT_MS: '20000' });
    const { data } = await srv.call('eo_login');
    assert.equal(data.status, 'not_registered');
    assert.equal(data.session_cache, 'saved');
    assert.match(data.next, /eo_register/);
    assert.ok(existsSync(join(srv.scratch, 'state.json')));
  });

  test('a state file that is not JSON just means logged out', async () => {
    const portal = await portalWith();
    const dir = mkdtempSync(join(tmpdir(), 'eo-state-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, 'not json');
    const srv = await serverWith({ EO_BASE_URL: portal.url, EO_STATE: file });
    assert.deepEqual((await srv.call('eo_status')).data, { status: 'login_required' });
  });
});

describe('shutdown', () => {
  test('a client that disconnects takes the server and its browser down promptly', async () => {
    const portal = await portalWith();
    const dir = mkdtempSync(join(tmpdir(), 'eo-down-'));
    const srv = await serverWith({ EO_BASE_URL: portal.url, EO_STATE: portal.sessionFile(dir) });
    assert.deepEqual((await srv.call('eo_status')).data, { status: 'ok' });
    const t = Date.now();
    await srv.stop();
    // stop() falls back to a kill after five seconds; leaving by itself is
    // well inside that.
    assert.ok(Date.now() - t < 4000, `took ${Date.now() - t} ms`);
    assert.equal(await srv.exited, 0);
    // And the browser went with it: nothing is left running on that profile.
    await new Promise(r => { setTimeout(r, 1500); });
    const left = spawnSync('pgrep', ['-f', join(srv.scratch, 'profile')], { encoding: 'utf8' });
    assert.equal(left.stdout.trim(), '', 'a browser is still running on the profile');
  });
});

describe('a browser that goes away', () => {
  test('is replaced on the next call instead of being used again', async () => {
    const portal = await portalWith();
    const dir = mkdtempSync(join(tmpdir(), 'eo-gone-'));
    const srv = await serverWith({ EO_BASE_URL: portal.url, EO_STATE: portal.sessionFile(dir) });
    assert.deepEqual((await srv.call('eo_status')).data, { status: 'ok' });
    // What closing the window amounts to: the browser on that profile is gone.
    spawnSync('pkill', ['-f', join(srv.scratch, 'profile')]);
    await new Promise(r => { setTimeout(r, 1500); });
    assert.deepEqual((await srv.call('eo_status')).data, { status: 'ok' });
    assert.equal((await srv.call('eo_list_periods')).data.periods.length, 2);
  });
});

describe('attached to a running browser', () => {
  test('EO_CDP_URL uses that browser\'s session, caches nothing and leaves it running', async () => {
    const portal = await portalWith();
    const port = 20000 + Math.floor(Math.random() * 20000);
    // Started through Playwright rather than by hand: it knows the flags a
    // browser needs to come up at all on a CI runner, where the sandbox Chrome
    // asks for is not available.
    const theirs = await chromium.launch({ headless: true, executablePath: someBrowser(), args: [`--remote-debugging-port=${port}`] });
    cleanup.push(() => theirs.close());
    const cdp = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await fetch(`${cdp}/json/version`).then(r => r.ok).catch(() => false);
      if (!up) await new Promise(r => { setTimeout(r, 100); });
    }
    assert.ok(up, 'the browser to attach to never opened its debugging port');
    // "Their" login: the cookie is put into the running browser from outside.
    const owner = await chromium.connectOverCDP(cdp);
    await owner.contexts()[0].addCookies([{ name: COOKIE, value: 'ok', url: portal.url }]);
    await owner.close();

    const srv = await serverWith({ EO_BASE_URL: portal.url, EO_CDP_URL: cdp });
    assert.deepEqual((await srv.call('eo_status')).data, { status: 'ok' });
    assert.equal((await srv.call('eo_list_periods')).data.periods.length, 2);
    const login = (await srv.call('eo_login')).data;
    assert.equal(login.status, 'ok');
    assert.equal(login.session_cache, 'attached');
    assert.ok(!existsSync(join(srv.scratch, 'state.json')));
    await srv.stop();
    // Still there after the server has gone.
    assert.ok(await fetch(`${cdp}/json/version`).then(r => r.ok));
  });

  test('a debugging port nothing listens on is an error naming it', async () => {
    const srv = await serverWith({ EO_CDP_URL: 'http://127.0.0.1:1' });
    const { raw, isError } = await srv.call('eo_status');
    assert.ok(isError);
    assert.match(raw, /127\.0\.0\.1:1/);
  });
});
