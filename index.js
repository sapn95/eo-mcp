#!/usr/bin/env node
// eo-mcp — MCP server for the Swiss EO portal (eo.zas.admin.ch), where people
// who served in the army, civil protection or civilian service claim their
// loss-of-earnings compensation (Erwerbsersatz, EO).
//
// The portal has no public API and its login goes through AGOV. What it does
// have is a JSON backend that its own web client talks to, and that is what
// this server uses: a browser is only there to carry the AGOV session. A
// persistent profile keeps the session, `eo_login` opens a visible window for
// the interactive login, and every call after that is a plain HTTP request sent
// with the browser's cookies.
//
// Reading: the service periods with their status, the claim form, the
// attachments, the employer register and the list of compensation offices.
// Writing: the registration with the confirmation code, changes to the DRAFT of
// a claim form, attachments.
//
// SAFETY: this server edits DRAFTS. A claim only goes to the compensation
// office through `eo_submit`, which requires an explicit confirm:true and
// otherwise answers with a dry run. Nothing is submitted any other way.
//
// SESSION CACHING: a persistent Chromium profile keeps the trusted-device
// state, and because a persistent profile drops session cookies when the
// browser closes, every successful call mirrors the session to `state.json`
// via `storageState()`. A fresh start re-seeds the context from that file.
//
// Env:
//   EO_PROFILE    browser profile dir  (default: ~/.eo-mcp/profile;
//                 empty = a throwaway profile, nothing is kept)
//   EO_STATE      storageState json    (default: ~/.eo-mcp/state.json;
//                 empty = do not cache the session at all)
//   EO_BROWSER    chrome | chrome-canary | edge | brave | chromium | abs. path
//                 (default: prefer an installed signed browser — see below)
//   EO_CDP_URL    attach to a browser that is already running with
//                 --remote-debugging-port instead of starting one, and use its
//                 session. Nothing is cached and the browser is left running.
//   EO_LANGUAGE   de | fr | it — the language the portal answers in and writes
//                 its confirmation mail in (default: de)
//   EO_LOGIN_HEADLESS  set to 1 to keep the eo_login window invisible. For the
//                 test suite and for machines without a display; a login needs
//                 somebody to look at it, so this is of no use against the
//                 real portal.
//   EO_BASE_URL   portal base URL (default: the real portal) — this exists so
//                 the test suite can point at a local fixture instead of the
//                 live claim of a real person.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { chromium } from 'playwright';
import { existsSync, readdirSync, mkdirSync, readFileSync, rmSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, isAbsolute } from 'node:path';

// Name and version come from package.json, never from a second copy here:
// `npm version` only bumps package.json, so a hardcoded string silently
// advertises a stale version to every client.
const PKG = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// An environment variable that is SET, even to the empty string, is the answer.
// Falling back to the default on an empty value makes it impossible to say "no
// session cache", and it lets a caller that tried to isolate itself — a test
// above all — silently pick up the real profile and the session inside it.
const envOr = (name, fallback) => (process.env[name] !== undefined ? process.env[name] : fallback);

const PROFILE = envOr('EO_PROFILE', join(homedir(), '.eo-mcp', 'profile'));
const STATE = envOr('EO_STATE', join(homedir(), '.eo-mcp', 'state.json'));
const CDP_URL = envOr('EO_CDP_URL', '');
const BASE = envOr('EO_BASE_URL', 'https://eo.zas.admin.ch').replace(/\/+$/, '');
if (!BASE) throw new Error('EO_BASE_URL is set but empty — refusing to guess a portal URL');
// Throws here, at startup, rather than inside the first tool call.
new URL(BASE);
const API = `${BASE}/napg/api/6`;
const HOME = `${BASE}/home`;

const LANGUAGES = ['de', 'fr', 'it'];
const LANGUAGE = envOr('EO_LANGUAGE', 'de');
if (!LANGUAGES.includes(LANGUAGE)) throw new Error(`EO_LANGUAGE="${LANGUAGE}" is not one of ${LANGUAGES.join(', ')}`);

// How long eo_login waits for somebody to finish the AGOV login, and how often
// it asks the portal whether they have. Overridable so a test does not have to
// sit through eight minutes to prove that an unfinished login is reported.
const num = (name, fallback) => { const n = Number(envOr(name, '')); return Number.isFinite(n) && n > 0 ? n : fallback; };
const LOGIN_TIMEOUT = num('EO_LOGIN_TIMEOUT_MS', 480000);
const LOGIN_POLL = num('EO_LOGIN_POLL_MS', 2000);
const LOGIN_HEADLESS = envOr('EO_LOGIN_HEADLESS', '') === '1';

// Prefer an installed, signed browser. AGOV offers a passkey only where the
// platform authenticator can be reached, and Playwright's bundled Chromium
// reports that there is none, so the login falls back to the slower factors.
const BROWSERS = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'chrome-canary': '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
};

function findChromium() {
  const want = envOr('EO_BROWSER', '');
  if (want && want !== 'chromium') {
    const path = BROWSERS[want] || want;
    if (!existsSync(path)) throw new Error(`EO_BROWSER="${want}" not found (looked at ${path})`);
    return path;
  }
  if (!want) {
    for (const key of ['chrome', 'chrome-canary', 'edge', 'brave']) {
      if (existsSync(BROWSERS[key])) return BROWSERS[key];
    }
  }
  try { const p = chromium.executablePath(); if (p && existsSync(p)) return p; } catch { /* scan */ }
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter(n => n.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(cache, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

// Re-seed a fresh context from the cached storageState. Best-effort: a missing
// or corrupt state file just means we start logged out and `eo_login` is needed.
async function seedFromState(c) {
  if (!STATE || !existsSync(STATE)) return;
  try {
    const saved = JSON.parse(readFileSync(STATE, 'utf8'));
    if (Array.isArray(saved.cookies) && saved.cookies.length) await c.addCookies(saved.cookies).catch(() => {});
  } catch { /* ignore unreadable/corrupt state.json */ }
}

// Mirror the live session to state.json so it survives a restart. Returns what
// actually happened, so a caller can stop promising persistence it did not get:
// 'saved', 'disabled' (EO_STATE is empty by choice), 'attached' (the session
// belongs to somebody else's browser and is not ours to copy), or 'failed'.
async function saveState() {
  try {
    if (attached) return 'attached';
    if (!STATE) return 'disabled';
    if (!ctx) return 'failed';
    // A session cookie is password-equivalent: whoever reads this file is
    // logged in as the claimant. Written with the process umask it would be
    // readable by every local user on a normal machine.
    mkdirSync(dirname(STATE), { recursive: true, mode: 0o700 });
    chmodSync(dirname(STATE), 0o700);
    await ctx.storageState({ path: STATE });
    chmodSync(STATE, 0o600);
    return 'saved';
  } catch { return 'failed'; }
}

let ctx = null, headed = false, attached = false;
async function browser(wantHeaded = false) {
  if (CDP_URL) {
    if (ctx) return ctx;
    const b = await chromium.connectOverCDP(CDP_URL);
    // The default context is the one the person is logged in with. A new
    // context would be a fresh, logged-out browser inside theirs.
    ctx = b.contexts()[0];
    if (!ctx) throw new Error(`EO_CDP_URL=${CDP_URL}: the browser there has no context to attach to`);
    attached = true;
    return ctx;
  }
  if (ctx && (headed || !wantHeaded)) return ctx;
  if (ctx) { await ctx.close().catch(() => {}); ctx = null; }
  // An empty EO_PROFILE means "no persistent profile": Playwright then uses a
  // throwaway directory, so nothing of the session is left on disk.
  if (PROFILE) {
    mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
    try { chmodSync(PROFILE, 0o700); } catch { /* not ours to tighten */ }
  }
  const launch = () => chromium.launchPersistentContext(PROFILE, {
    headless: !wantHeaded || LOGIN_HEADLESS, executablePath: findChromium(),
    locale: `${LANGUAGE}-CH`, viewport: { width: 1400, height: 1000 },
  });
  try {
    ctx = await launch();
  } catch (e) {
    // A browser killed rather than closed leaves SingletonLock behind and
    // Chrome then refuses to start at all, so every later call fails the same.
    if (!PROFILE || !/ProcessSingleton|SingletonLock/.test(e.message || '')) throw e;
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try { rmSync(join(PROFILE, f), { force: true }); } catch { /* nothing to clear */ }
    }
    ctx = await launch();
  }
  headed = wantHeaded;
  await seedFromState(ctx);
  return ctx;
}

// ---- the portal's backend ----

// Thrown by `api` when the portal answers as it does to a browser nobody is
// logged in with, and turned into status "login_required" in one place below.
class LoginRequired extends Error {}

// One request to the backend, sent with the browser's cookies. Redirects are
// not followed: an expired session is answered with a redirect to AGOV, and
// following it would hand back a login page with status 200.
async function api(method, path, { json, multipart, params } = {}) {
  const c = await browser(headed);
  const r = await c.request.fetch(`${API}${path}`, {
    method,
    // The portal's own client sends this header on every call to the backend.
    headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    ...(json !== undefined ? { data: json } : {}),
    ...(multipart ? { multipart } : {}),
    ...(params ? { params } : {}),
    maxRedirects: 0, failOnStatusCode: false, timeout: 30000,
  });
  const status = r.status();
  const type = r.headers()['content-type'] || '';
  const body = await r.text().catch(() => '');
  // 401 is what the backend says to its own client; a redirect or a page of
  // HTML where JSON was asked for is what the gateway in front of it says.
  if (status === 401 || (status >= 300 && status < 400) || (status === 200 && body && /text\/html/i.test(type))) {
    throw new LoginRequired();
  }
  let data = null;
  if (body && /json/i.test(type)) { try { data = JSON.parse(body); } catch { /* reported as text below */ } }
  return { status, ok: status >= 200 && status < 300, data, text: data === null ? body.slice(0, 500) : '' };
}

// What the portal said when it refused something, in its own words where it
// gave any. The backend answers with RFC 7807 problem documents.
const refusal = r => {
  const d = r.data && typeof r.data === 'object' ? r.data : null;
  return { http: r.status, ...(d ? { portal: d } : r.text ? { portal: r.text } : {}) };
};

// A business id goes into a URL path. The ones the portal hands out are digits
// and underscores; anything else is refused rather than encoded and sent.
const BUSINESS_ID = /^[A-Za-z0-9_-]{1,64}$/;
function businessId(args) {
  const id = args.business_id;
  if (typeof id !== 'string' || !BUSINESS_ID.test(id)) {
    throw new Error('business_id fehlt oder ist ungültig — eo_list_periods nennt die Fall-ID jeder Periode');
  }
  return id;
}

async function cases() {
  const r = await api('GET', '/cases');
  if (!r.ok || !Array.isArray(r.data)) throw new Error(`Die Fallübersicht liess sich nicht lesen (HTTP ${r.status})`);
  return r.data;
}

// The case behind a business id, or an error naming the ones there are. Every
// tool that works on one period starts here, so a mistyped id never reaches a
// write.
async function caseFor(id) {
  const all = await cases();
  const found = all.find(c => c.businessId === id);
  if (!found) {
    const known = all.map(c => c.businessId);
    throw new Error(`Keine Periode mit der Fall-ID ${id}${known.length ? ` — vorhanden: ${known.join(', ')}` : ' — das Portal führt für dieses Konto keine Perioden'}`);
  }
  return found;
}

// Case states, as the portal's client names them. Only EDITING is a draft the
// claimant can still change; everything after it belongs to the compensation
// office.
const STATUS_TEXT = {
  INITIATED: 'eröffnet', ERROR: 'Fehler', READY_FOR_ASTREINT: 'bereit zum Ausfüllen', EDITING: 'zu ergänzen',
  ASSIGNED: 'eingereicht, bei der Ausgleichskasse', PAPER: 'Papierformular verlangt', CLOSED: 'abgeschlossen',
  PRESCRIBED: 'verjährt', ARCHIVED: 'archiviert',
};

async function listPeriods() {
  const all = await cases();
  const periods = [];
  for (const c of all) {
    // The period a case belongs to is addressed by the version the case names.
    const r = await api('GET', `/service-periods/${encodeURIComponent(c.businessId)}/${encodeURIComponent(c.servicePeriodVersion)}`);
    periods.push({
      business_id: c.businessId,
      status: c.status,
      status_text: STATUS_TEXT[c.status] || null,
      created_at: c.createdAt ?? null,
      modified_at: c.modifiedAt ?? null,
      compensation_office: c.assignedCompensationOffice ?? null,
      // A period that could not be read is said to be unread, not left out: the
      // case exists either way, and a missing key would read as "no details".
      ...(r.ok && r.data ? { period: r.data } : { period: null, period_error: refusal(r) }),
    });
  }
  return periods;
}

const ATTACHMENT_CATEGORIES = {
  FEUCOMP_001: 'Ergänzungsblatt 1 zum EO-Antrag (Pflegekinder)',
  FEUCOMP_002: 'Ergänzungsblatt 2 zum EO-Antrag (landwirtschaftliche Betriebszulage)',
  FEUCOMP_003: 'Antrag auf Betreuungskostenzulage',
  FEUCOMP_004: 'Ergänzungsblatt 4 zum EO-Antrag (Militärdienst)',
  ATTFORMENF_001: 'Ausbildungsbestätigung des Kindes',
  ATTFORMENF_002: 'Ausbildungsbestätigung des Pflege-/Stiefkindes',
  FICHEETRAN_001: 'Lohnabrechnung ausländischer Arbeitgeber',
  CHOMAGE_001: 'Abrechnung der Leistungen der Arbeitslosenversicherung',
  FINFORMAST_001: 'Bescheinigung über den Abschluss der Ausbildung',
  ATTFORMAST_001: 'Ausbildungsbestätigung der dienstleistenden Person',
  DIVERS_001: 'Weitere Dokumente',
};

async function attachments(id) {
  const r = await api('GET', `/cases/${encodeURIComponent(id)}/attachments`);
  if (!r.ok || !Array.isArray(r.data?.attachments)) throw new Error(`Die Beilagen liessen sich nicht lesen (HTTP ${r.status})`);
  return r.data.attachments;
}

// The form of a case: the draft itself, or null where the portal has none yet.
async function form(id) {
  const r = await api('GET', `/cases/${encodeURIComponent(id)}/form`);
  if (r.status === 404) return null;
  if (!r.ok || !r.data || typeof r.data !== 'object') throw new Error(`Das Formular liess sich nicht lesen (HTTP ${r.status})`);
  return r.data;
}

// The required attachment categories nothing has been uploaded for. Counted
// from the attachment list rather than from the counters in the form, which
// the portal's own client keeps in step by hand.
function missingAttachments(f, list) {
  return (f.categoryRequirements || [])
    .filter(c => c.isRequired && !list.some(a => a.categoryId === c.categoryId))
    .map(c => ({ category: c.categoryId, name: ATTACHMENT_CATEGORIES[c.categoryId] || null }));
}

// ---- changing the draft ----

// Fields the backend owns. `version` is its optimistic lock and is sent back
// exactly as it was read, so a change made elsewhere in the meantime is
// refused by the portal instead of overwritten by us.
const SERVER_OWNED = ['version', 'servicePeriodVersion', 'categoryRequirements'];
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Lay `changes` over `target`: objects are merged key by key, everything else
// replaces what was there. null is a value here, not "delete this key" — the
// portal's form says "not answered" with an explicit null and expects the key.
function merge(target, changes) {
  const out = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(changes)) {
    if (FORBIDDEN_KEYS.includes(k)) throw new Error(`changes darf den Schlüssel "${k}" nicht enthalten`);
    out[k] = isObject(v) ? merge(out[k], v) : v;
  }
  return out;
}

// Every path `changes` sets, down to the first thing that is not an object.
function leaves(changes, prefix = []) {
  return Object.entries(changes).flatMap(([k, v]) =>
    isObject(v) && Object.keys(v).length ? leaves(v, [...prefix, k]) : [{ path: [...prefix, k], value: v }]);
}
const at = (obj, path) => path.reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function updateForm(id, changes) {
  if (!isObject(changes) || !Object.keys(changes).length) {
    throw new Error('changes muss ein Objekt mit mindestens einem Feld sein, z.B. {"familySituation":{"hasChildren":false}}');
  }
  const owned = Object.keys(changes).filter(k => SERVER_OWNED.includes(k));
  if (owned.length) throw new Error(`changes darf ${owned.join(', ')} nicht setzen — diese Felder führt das Portal selbst`);
  const c = await caseFor(id);
  if (c.status !== 'EDITING') {
    return {
      updated: false, status: c.status,
      error: `Die Periode ist im Status ${c.status} (${STATUS_TEXT[c.status] || 'unbekannt'}) — nur ein Antrag im Status EDITING lässt sich ändern; es wurde nichts geschrieben`,
    };
  }
  const current = await form(id);
  if (!current) {
    // The portal's client creates the form the first time a period is opened,
    // from defaults it assembles itself. Guessing those here would put a form
    // nobody has seen into a real claim.
    return { updated: false, error: 'Für diese Periode gibt es noch kein Formular — bitte die Periode einmal im Portal öffnen; es wurde nichts geschrieben' };
  }
  const next = merge(current, changes);
  const r = await api('PUT', `/cases/${encodeURIComponent(id)}/form`, { json: next });
  if (r.status === 409) {
    return { updated: false, ...refusal(r), error: 'Das Formular wurde inzwischen anderswo geändert (Versionskonflikt) — es wurde nichts geschrieben; bitte neu lesen und erneut ändern' };
  }
  if (!r.ok || !isObject(r.data)) {
    return { updated: false, ...refusal(r), error: 'Das Portal hat die Änderung abgelehnt — es wurde nichts geschrieben' };
  }
  // Read back what the portal kept, and compare it with what was asked for. A
  // 200 says the request was accepted, not that every value survived it.
  const differing = leaves(changes).filter(l => !same(at(r.data, l.path), l.value))
    .map(l => ({ field: l.path.join('.'), asked: l.value, kept: at(r.data, l.path) ?? null }));
  return {
    updated: true,
    ...(differing.length ? { warning: 'Das Portal hat nicht alle Werte so übernommen wie verlangt', differing } : {}),
    form: r.data,
  };
}

// ---- attachments ----

const UPLOAD_MAX = 5 * 1024 * 1024;   // the limit the portal's client enforces
function checkUpload(file) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('file muss ein absoluter Pfad sein');
  let st;
  try { st = statSync(file); } catch { throw new Error(`file gibt es nicht: ${file}`); }
  if (!st.isFile()) throw new Error(`file ist keine Datei: ${file}`);
  if (!st.size) throw new Error(`file ist leer: ${file}`);
  if (st.size > UPLOAD_MAX) throw new Error(`file ist grösser als 5 MB, mehr nimmt das Portal nicht an: ${file}`);
}

// ---- tool definitions ----
const TOOLS = [
  { name: 'eo_status', description: 'Check whether the EO portal session is alive (ok) or an interactive AGOV login is needed (login_required). Call this before anything else; it also refreshes the cached session.', inputSchema: { type: 'object', properties: {} } },
  { name: 'eo_login', description: 'Open a visible browser window for the AGOV login and wait until the portal itself answers as logged in (up to 8 min). Only status "ok" means the login went through; a login nobody finished comes back as login_required and nothing is cached.', inputSchema: { type: 'object', properties: {} } },
  { name: 'eo_register', description: 'First-time registration: link the logged-in AGOV account to the claimant with the confirmation code (Bestätigungscode, a UUID) from the mail or SMS "Registrierung auf dem EO-Portal". The portal answers with a result such as SUCCESS_TOKEN, USED_TOKEN, EXPIRED_TOKEN or UNKNOWN_TOKEN, which is passed on as it came. Not needed again once the periods are listed.', inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'the confirmation code, e.g. 00000000-0000-0000-0000-000000000000' } }, required: ['code'] } },
  { name: 'eo_list_periods', description: 'The service periods of the logged-in person, each with its business_id (Fall-ID), case status (EDITING = draft to complete, ASSIGNED = submitted to the compensation office, …) and the period as the service organisation reported it: service type, dates, number of days, address, IBAN. An empty list is what an account without a registration looks like — see eo_register.', inputSchema: { type: 'object', properties: {} } },
  { name: 'eo_get_form', description: 'The claim form of one period as the portal stores it: activity (hasIncome, activityType, activityDetails with the employer), familySituation, bankAccountDetails, contactDetails, isServicePeriodValidated — plus the uploaded attachments and the required attachment categories that are still missing. form is null where the period has never been opened in the portal.', inputSchema: { type: 'object', properties: { business_id: { type: 'string' } }, required: ['business_id'] } },
  { name: 'eo_update_form', description: 'Change the DRAFT of a claim form. changes is laid over the stored form: objects are merged key by key, any other value (including an array and null) replaces what was there — so {"familySituation":{"hasChildren":false}} touches that one answer. Read the form with eo_get_form first and keep to its field names. An employee, as the portal stores one: activity = {hasIncome:true, employerInSwitzerland:true, activityType:"EMPLOYEE", activityDetails:{_type:"ActivityEmployee", employer:{uid, organisationName, town, npa, address, cantonAbbreviation, compensationOffice:{uid, notFound:false, accountNumber:null}, notFound:false, byUid:true, farmingAllowance:false}, otherEmployer:[]}}, with the employer taken from eo_search_employers. activityType is one of EMPLOYEE, APPRENTICE, STUDENT, FREELANCE, FREELANCE_AND_EMPLOYEE, NOT_GAINFULLY_EMPLOYED, UNEMPLOYED_WITH_INTERMEDIATE_PROFIT, UNEMPLOYED_WITHOUT_INTERMEDIATE_PROFIT, INTERNATIONAL_EMPLOYEES, ANOBAG. Only a case in status EDITING is changed, the write carries the version that was read (a change made elsewhere in between is refused, not overwritten), and the stored form is read back and compared with what was asked for. Nothing is submitted by this.', inputSchema: { type: 'object', properties: { business_id: { type: 'string' }, changes: { type: 'object', description: 'partial form, merged into the stored one' } }, required: ['business_id', 'changes'] } },
  { name: 'eo_search_employers', description: 'Look an employer up in the register the portal uses, by name (optionally narrowed by zip, town, canton) or by uid (CHE-123.456.789, any punctuation). Each hit carries uid, organisationName, address, npa, town, cantonAbbreviation and the uid of its compensation office.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, zip: { type: 'string' }, town: { type: 'string' }, canton: { type: 'string', description: 'two letters, e.g. BE' }, uid: { type: 'string' } } } },
  { name: 'eo_compensation_offices', description: 'The compensation offices (Ausgleichskassen) the portal knows, each with id, uid and description. query filters by a substring of the description or by uid.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'eo_upload_attachment', description: 'Attach a file to the draft of one period. file = absolute path, at most 5 MB. category is one of FEUCOMP_001…004, ATTFORMENF_001/002, FICHEETRAN_001, CHOMAGE_001, FINFORMAST_001, ATTFORMAST_001 or DIVERS_001 (other documents); eo_get_form names the categories a claim still requires. Whether the file type is accepted is the portal\'s decision and its answer is passed on.', inputSchema: { type: 'object', properties: { business_id: { type: 'string' }, category: { type: 'string' }, file: { type: 'string' } }, required: ['business_id', 'category', 'file'] } },
  { name: 'eo_delete_attachment', description: 'Remove one uploaded attachment from the draft of a period, by the id eo_get_form lists it under. An id the period does not have is refused before anything is sent.', inputSchema: { type: 'object', properties: { business_id: { type: 'string' }, attachment_id: { type: 'string' } }, required: ['business_id', 'attachment_id'] } },
  { name: 'eo_submit', description: 'DANGER: confirm the claim and send it to the compensation office. Irreversible. Requires confirm:true; otherwise returns a dry run with the period, the form and the attachments exactly as they would be sent. Refused, confirm:true and all, where the case is not in status EDITING (already_submitted for a case that is past it), where the period has not been confirmed as correct, where no activity is chosen, or where a required attachment is missing. submitted:true is only reported once the portal lists the case in a status other than EDITING.', inputSchema: { type: 'object', properties: { business_id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['business_id'] } },
];

const server = new Server({ name: PKG.name, version: PKG.version }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Take the browser down with us — unless it is somebody else's. A browser we
// attached to over CDP was running before this server started and holds the
// person's other tabs; exiting drops the connection and leaves it alone.
let goingDown = false;
async function shutdown() {
  if (goingDown) return;
  goingDown = true;
  // With a deadline. A browser that was started moments ago can take longer to
  // close in good order than a client is prepared to wait, and this used to sit
  // on that until a kill signal arrived. Exiting is enough to take it down:
  // Playwright ends the browsers it started when this process goes.
  const closing = ctx && !attached ? ctx.close().catch(() => {}) : null;
  if (closing) await Promise.race([closing, new Promise(r => { setTimeout(r, 1500); })]);
  process.exit(0);
}
server.onclose = () => { void shutdown(); };
// A client that goes away closes our stdin, and the transport does not report
// that as a close: the browser child then keeps this process alive, logged in,
// with nobody on the other end.
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// One tool call at a time. A read-modify-write of the form that interleaves
// with another one loses a change, and a client is free to pipeline requests.
let turnQueue = Promise.resolve();
function takeTurn() {
  let release;
  const held = new Promise(r => { release = r; });
  const ourTurn = turnQueue;
  turnQueue = turnQueue.then(() => held);
  return ourTurn.then(() => release);
}

const sleep = ms => new Promise(r => { setTimeout(r, ms); });

// Is anybody logged in? Asked of the backend, because that is the only thing
// whose answer means it: an address bar on the portal's host proves nothing.
async function sessionStatus() {
  try { await cases(); return 'ok'; } catch (e) {
    if (e instanceof LoginRequired) return 'login_required';
    throw e;
  }
}

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;
  const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
  const release = await takeTurn();
  try {
    if (name === 'eo_status') {
      const status = await sessionStatus();
      if (status === 'ok') await saveState();
      return text({ status });
    }
    if (name === 'eo_login') {
      const c = await browser(true);
      // A tab of our own, also in an attached browser: the person's tabs are
      // theirs, and one of them may hold a half-filled form.
      const p = attached ? await c.newPage() : (c.pages()[0] || await c.newPage());
      await p.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await p.bringToFront().catch(() => {});
      const deadline = Date.now() + LOGIN_TIMEOUT;
      let status = await sessionStatus();
      while (status !== 'ok' && Date.now() < deadline) {
        await sleep(LOGIN_POLL);
        status = await sessionStatus();
      }
      if (status !== 'ok') {
        return text({ status, message: 'Die Anmeldung ist nicht abgeschlossen — das Portal weist niemanden als angemeldet aus. Bitte eo_login erneut aufrufen und die AGOV-Anmeldung im Fenster zu Ende führen; es wurde nichts zwischengespeichert.' });
      }
      const cached = await saveState();
      return text({
        status: 'ok',
        session_cache: cached,
        message: {
          saved: 'AGOV-Anmeldung erfolgreich, Session in state.json gespeichert (überlebt Server-Neustarts).',
          disabled: 'AGOV-Anmeldung erfolgreich. EO_STATE ist leer — die Session wird NICHT zwischengespeichert und ist nach einem Neustart weg.',
          attached: 'AGOV-Anmeldung erfolgreich. Die Session gehört dem Browser hinter EO_CDP_URL und wird nicht kopiert.',
          failed: 'AGOV-Anmeldung erfolgreich, aber die Session konnte nicht gespeichert werden — nach einem Neustart ist ein neuer Login nötig.',
        }[cached],
      });
    }
    if (name === 'eo_register') {
      const code = typeof args.code === 'string' ? args.code.trim() : '';
      // The portal refuses anything else with "Das eingegebene UUID-Format ist
      // ungültig"; saying so here saves a round trip that can only fail.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code)) {
        return text({ registered: false, error: 'code ist kein Bestätigungscode — erwartet wird eine UUID wie 00000000-0000-0000-0000-000000000000; es wurde nichts gesendet' });
      }
      const r = await api('POST', '/astreints/onboarding', { json: { token: code, language: LANGUAGE } });
      if (!r.ok) return text({ registered: false, ...refusal(r), error: 'Das Portal hat den Bestätigungscode nicht angenommen' });
      await saveState();
      // What the portal answered is passed on rather than interpreted, and the
      // periods are the evidence: a registration that worked lists some.
      return text({ registered: true, portal: r.data ?? r.text, periods: await listPeriods() });
    }
    if (name === 'eo_list_periods') {
      const periods = await listPeriods();
      await saveState();
      return text({
        periods,
        ...(periods.length ? {} : { hint: 'Das Portal führt für dieses Konto keine Perioden. Ist das Konto noch nicht registriert, braucht es den Bestätigungscode aus dem Mail "Registrierung auf dem EO-Portal" (eo_register).' }),
      });
    }
    if (name === 'eo_get_form') {
      const id = businessId(args);
      const c = await caseFor(id);
      const f = await form(id);
      const list = await attachments(id);
      await saveState();
      return text({
        business_id: id, status: c.status, status_text: STATUS_TEXT[c.status] || null,
        form: f,
        ...(f ? {} : { hint: 'Für diese Periode gibt es noch kein Formular — es entsteht, sobald die Periode einmal im Portal geöffnet wird.' }),
        attachments: list,
        missing_attachments: f ? missingAttachments(f, list) : [],
      });
    }
    if (name === 'eo_update_form') {
      const id = businessId(args);
      const result = await updateForm(id, args.changes);
      await saveState();
      return text({ business_id: id, ...result });
    }
    if (name === 'eo_search_employers') {
      const str = k => (typeof args[k] === 'string' ? args[k].trim() : '');
      if (str('uid')) {
        // CHE-123.456.789, CHE123456789 and 123456789 are all the same number.
        const digits = str('uid').replace(/[^0-9]/g, '');
        if (digits.length !== 9) return text({ error: 'uid braucht neun Ziffern, z.B. CHE-123.456.789' });
        const r = await api('GET', `/uids/CHE${digits}`);
        if (r.status === 404) return text({ employers: [], hint: `Das Register kennt keine UID CHE${digits}` });
        if (!r.ok) return text({ ...refusal(r), error: 'Die UID liess sich nicht nachschlagen' });
        return text({ employers: [r.data].flat().filter(Boolean) });
      }
      if (!str('name')) return text({ error: 'name oder uid ist nötig — das Register lässt sich nicht ohne Firmennamen durchsuchen' });
      const params = { organisationName: str('name') };
      if (str('zip')) params.npa = str('zip');
      if (str('town')) params.town = str('town');
      if (str('canton')) params.cantonAbbreviation = str('canton').toUpperCase();
      const r = await api('GET', '/uids', { params });
      if (r.status === 504) return text({ error: 'Die Suche im Register hat zu lange gedauert — bitte mit Ort oder PLZ einschränken und erneut versuchen' });
      if (!r.ok || !Array.isArray(r.data)) return text({ ...refusal(r), error: 'Die Suche im Register ist fehlgeschlagen' });
      return text({ employers: r.data });
    }
    if (name === 'eo_compensation_offices') {
      const r = await api('GET', '/compensation-offices', { params: { lang: LANGUAGE } });
      if (!r.ok || !Array.isArray(r.data)) return text({ ...refusal(r), error: 'Die Liste der Ausgleichskassen liess sich nicht lesen' });
      const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const offices = q
        ? r.data.filter(o => String(o.description || '').toLowerCase().includes(q) || String(o.uid || '').toLowerCase() === q.replace(/[^a-z0-9]/g, ''))
        : r.data;
      return text({ offices, ...(q ? { of: r.data.length } : {}) });
    }
    if (name === 'eo_upload_attachment') {
      const id = businessId(args);
      if (!Object.hasOwn(ATTACHMENT_CATEGORIES, args.category)) {
        return text({ uploaded: false, error: `category "${args.category}" gibt es nicht`, categories: ATTACHMENT_CATEGORIES });
      }
      // Checked before the portal is asked anything at all.
      checkUpload(args.file);
      const c = await caseFor(id);
      if (c.status !== 'EDITING') {
        return text({ uploaded: false, status: c.status, error: `Die Periode ist im Status ${c.status} — Beilagen lassen sich nur einem Antrag im Status EDITING anhängen; es wurde nichts hochgeladen` });
      }
      const r = await api('POST', `/cases/${encodeURIComponent(id)}/attachments`, {
        multipart: {
          categoryId: args.category,
          attachment: { name: basename(args.file), mimeType: 'application/octet-stream', buffer: readFileSync(args.file) },
        },
      });
      if (!r.ok) return text({ uploaded: false, ...refusal(r), error: 'Das Portal hat die Datei nicht angenommen' });
      await saveState();
      // The list is the evidence that it is there, not the answer to the POST.
      return text({ uploaded: true, attachment: r.data, attachments: await attachments(id) });
    }
    if (name === 'eo_delete_attachment') {
      const id = businessId(args);
      const want = String(args.attachment_id ?? '');
      const before = await attachments(id);
      const hit = before.find(a => String(a.id) === want);
      if (!hit) return text({ deleted: false, error: `Die Periode hat keine Beilage mit der id "${want}" — es wurde nichts gelöscht`, attachments: before });
      const r = await api('DELETE', `/cases/${encodeURIComponent(id)}/attachments/${encodeURIComponent(hit.id)}`);
      if (!r.ok) return text({ deleted: false, ...refusal(r), error: 'Das Portal hat das Löschen abgelehnt' });
      const after = await attachments(id);
      const gone = !after.some(a => String(a.id) === want);
      await saveState();
      return text(gone
        ? { deleted: true, attachments: after }
        : { deleted: false, error: 'Das Portal hat das Löschen bestätigt, führt die Beilage aber weiterhin — bitte im Portal prüfen', attachments: after });
    }
    if (name === 'eo_submit') {
      const id = businessId(args);
      const c = await caseFor(id);
      // Nothing is sent for a case that is not a draft. A case past EDITING has
      // been confirmed already, and a second confirmation could prove nothing.
      if (c.status !== 'EDITING') {
        const past = ['ASSIGNED', 'CLOSED', 'ARCHIVED'].includes(c.status);
        return text({
          submitted: false, status: c.status, ...(past ? { already_submitted: true } : {}),
          error: `Die Periode ist im Status ${c.status} (${STATUS_TEXT[c.status] || 'unbekannt'}), nicht EDITING — es wurde nichts gesendet`,
        });
      }
      const f = await form(id);
      if (!f) return text({ submitted: false, error: 'Für diese Periode gibt es noch kein Formular — es wurde nichts gesendet' });
      const list = await attachments(id);
      const missing = missingAttachments(f, list);
      const open = [
        ...(f.isServicePeriodValidated === true ? [] : ['Die Angaben zur Dienstperiode sind nicht als korrekt bestätigt (isServicePeriodValidated)']),
        ...(f.activity?.activityType ? [] : ['Es ist keine Tätigkeit gewählt (activity.activityType)']),
        ...missing.map(m => `Pflichtbeilage fehlt: ${m.category}${m.name ? ` (${m.name})` : ''}`),
      ];
      const periodAnswer = await api('GET', `/service-periods/${encodeURIComponent(id)}/${encodeURIComponent(c.servicePeriodVersion)}`);
      const summary = { business_id: id, period: periodAnswer.ok ? periodAnswer.data : null, form: f, attachments: list };
      if (open.length) {
        return text({ submitted: false, incomplete: open, error: 'Der Antrag ist nicht vollständig — es wurde nichts gesendet', ...summary });
      }
      if (args.confirm !== true) {
        return text({
          dry_run: true,
          message: 'Nicht eingereicht. So würde der Antrag an die Ausgleichskasse gehen. Zum tatsächlichen Einreichen eo_submit mit confirm:true aufrufen — das lässt sich nicht zurücknehmen.',
          ...summary,
        });
      }
      const r = await api('POST', `/cases/${encodeURIComponent(id)}/confirm`, { json: { language: LANGUAGE } });
      if (!r.ok) return text({ submitted: false, ...refusal(r), error: 'Das Portal hat die Bestätigung abgelehnt — der Antrag ist nicht eingereicht' });
      // An accepted request is not a submitted claim. The case list is asked
      // again, and only a status other than EDITING there counts.
      const now = (await cases()).find(x => x.businessId === id);
      await saveState();
      if (!now || now.status === 'EDITING') {
        return text({ submitted: false, portal: r.data ?? r.text, error: 'Das Portal hat die Bestätigung angenommen, führt die Periode aber weiterhin als nicht eingereicht — bitte im Portal prüfen, bevor erneut eingereicht wird' });
      }
      return text({
        submitted: true, business_id: id, status: now.status, status_text: STATUS_TEXT[now.status] || null,
        compensation_office: now.assignedCompensationOffice ?? null,
      });
    }
    return text({ error: `unknown tool ${name}` });
  } catch (e) {
    if (e instanceof LoginRequired) {
      return text({ status: 'login_required', message: 'Im EO-Portal ist niemand angemeldet — bitte zuerst eo_login.' });
    }
    return { content: [{ type: 'text', text: 'ERROR: ' + (e.message || String(e)) }], isError: true };
  } finally {
    // Whatever happened, the next caller gets its turn.
    release();
  }
});

await server.connect(new StdioServerTransport());
