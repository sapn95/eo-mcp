// Offline checks: the MCP surface, the startup guards, and the arguments that
// are refused before a browser is touched.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer, startBroken } from './client.mjs';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const servers = [];
const spawnServer = async (env, opts) => { const s = await startServer(env, opts); servers.push(s); return s; };
after(async () => { await Promise.all(servers.map(s => s.stop())); });

describe('protocol', () => {
  test('advertises itself with the name and version from package.json', async () => {
    const srv = await spawnServer({ EO_BROWSER: '/nonexistent' });
    assert.equal(srv.init.result.serverInfo.name, PKG.name);
    assert.equal(srv.init.result.serverInfo.version, PKG.version);
  });

  test('every tool has a description and a well-formed input schema', async () => {
    const srv = await spawnServer({ EO_BROWSER: '/nonexistent' });
    const tools = await srv.tools();
    assert.ok(tools.length >= 11);
    for (const t of tools) {
      assert.match(t.name, /^eo_[a-z_]+$/);
      assert.ok(t.description.length > 20, t.name);
      assert.equal(t.inputSchema.type, 'object', t.name);
      for (const req of t.inputSchema.required || []) assert.ok(Object.hasOwn(t.inputSchema.properties, req), `${t.name}.${req}`);
    }
  });

  test('the submit tool says it is irreversible and names its confirmation', async () => {
    const srv = await spawnServer({ EO_BROWSER: '/nonexistent' });
    const submit = (await srv.tools()).find(t => t.name === 'eo_submit');
    assert.ok(submit, 'eo_submit must exist');
    assert.match(submit.description, /DANGER/);
    assert.match(submit.description, /confirm:true/);
    assert.equal(submit.inputSchema.properties.confirm.type, 'boolean');
  });

  test('an unknown tool is named as such', async () => {
    const srv = await spawnServer({ EO_BROWSER: '/nonexistent' });
    const { data } = await srv.call('eo_nope');
    assert.match(data.error, /unknown tool eo_nope/);
  });

  test('a business id that is no id is refused before the browser is touched', async () => {
    const srv = await spawnServer({ EO_BROWSER: '/nonexistent' });
    for (const id of [undefined, '', '../cases', 'a b', 42]) {
      const { raw, isError } = await srv.call('eo_get_form', { business_id: id });
      assert.ok(isError, String(id));
      assert.match(raw, /business_id fehlt oder ist ungültig/);
    }
  });

  test('a confirmation code that is no UUID is not sent anywhere', async () => {
    const srv = await spawnServer({ EO_BROWSER: '/nonexistent' });
    for (const code of [undefined, '', 'abc', '11111111-1111-4111-8111-11111111111']) {
      const { data } = await srv.call('eo_register', { code });
      assert.equal(data.registered, false, String(code));
      assert.match(data.error, /kein Bestätigungscode/);
    }
  });

  test('an upload is checked before the browser is touched', async () => {
    const srv = await spawnServer({ EO_BROWSER: '/nonexistent' });
    const base = { business_id: '1_2_1', category: 'DIVERS_001' };
    assert.match((await srv.call('eo_upload_attachment', { ...base, file: 'relative/Example.pdf' })).raw, /absoluter Pfad/);
    assert.match((await srv.call('eo_upload_attachment', { ...base, file: '/nonexistent/Example.pdf' })).raw, /gibt es nicht/);
    assert.match((await srv.call('eo_upload_attachment', { ...base, file: '/' })).raw, /keine Datei/);
    const { data } = await srv.call('eo_upload_attachment', { ...base, category: 'NOPE', file: '/x' });
    assert.equal(data.uploaded, false);
    assert.ok(data.categories.DIVERS_001);
  });

  test('an employer search without a name or uid is refused', async () => {
    const srv = await spawnServer({ EO_BROWSER: '/nonexistent' });
    assert.match((await srv.call('eo_search_employers', {})).data.error, /name oder uid/);
    assert.match((await srv.call('eo_search_employers', { uid: 'CHE-12' })).data.error, /neun Ziffern/);
  });

  test('a browser path that does not exist names EO_BROWSER', async () => {
    const srv = await spawnServer({ EO_BROWSER: '/nonexistent/browser' });
    const { raw, isError } = await srv.call('eo_status');
    assert.ok(isError);
    assert.match(raw, /EO_BROWSER="\/nonexistent\/browser" not found/);
  });
});

describe('startup guards', () => {
  test('an empty EO_BASE_URL is refused rather than replaced by the real portal', async () => {
    const { code, stderr } = await startBroken({ EO_BASE_URL: '', EO_STATE: '', EO_PROFILE: '' });
    assert.notEqual(code, 0);
    assert.match(stderr, /EO_BASE_URL is set but empty/);
    assert.ok(!stderr.includes('eo.zas.admin.ch'), 'and must not fall back to it');
  });

  test('a malformed EO_BASE_URL fails at startup, not inside the first call', async () => {
    const { code, stderr } = await startBroken({ EO_BASE_URL: 'not a url', EO_STATE: '', EO_PROFILE: '' });
    assert.notEqual(code, 0);
    assert.match(stderr, /Invalid URL/);
  });

  test('a language the portal does not speak is refused', async () => {
    const { code, stderr } = await startBroken({ EO_BASE_URL: 'http://127.0.0.1:1', EO_LANGUAGE: 'en', EO_STATE: '', EO_PROFILE: '' });
    assert.notEqual(code, 0);
    assert.match(stderr, /EO_LANGUAGE="en" is not one of de, fr, it/);
  });
});
