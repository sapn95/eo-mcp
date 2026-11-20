// A stand-in for the EO portal: the handful of backend routes the server uses,
// with the same shapes the real backend answers in, and a login page that can
// "finish" a login by itself. Everything in it is made up — the person is
// called Example, and no value here was ever a real claim.
//
// The knobs on `state` are the ways a portal can disagree with a client that
// believes its own request: refuse a write, change a value on the way in,
// accept a confirmation and then not act on it.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COOKIE = 'eo_fixture_session';
export const ID = '00000000001_00000000002_1';
export const OTHER_ID = '00000000001_00000000003_1';
// Assembled at runtime: the hygiene scan matches the IBAN shape wherever it
// finds it, including in a fixture.
export const IBAN = 'CH' + '93' + '0076' + '2011' + '6238' + '5295' + '7';

const freshState = () => ({
  cases: [
    { assignedCompensationOffice: null, assignmentRule: null, astreintId: 'a0000000-0000-0000-0000-000000000001', businessId: ID, createdAt: '2026-01-10T01:00:00+01:00', lastServicePeriodValidationVersion: 1, modifiedAt: '2026-01-12T10:00:00+01:00', servicePeriodVersion: 1, status: 'EDITING' },
    { assignedCompensationOffice: 'CHE000000001', assignmentRule: null, astreintId: 'a0000000-0000-0000-0000-000000000001', businessId: OTHER_ID, createdAt: '2025-06-10T01:00:00+02:00', lastServicePeriodValidationVersion: 1, modifiedAt: '2025-06-12T10:00:00+02:00', servicePeriodVersion: 2, status: 'ASSIGNED' },
  ],
  periods: {
    [`${ID}/1`]: { address: { addressLine1: 'Example_Street 1', addressLine2: '', addressLine3: '', town: 'Example_Town', zipCode: '0000' }, annotation: '', businessId: ID, endOfPeriod: '2026-01-06', formType: '318.737', iban: IBAN, insurant: { vn: 7560000000002, officialName: 'Example_Name', firstName: 'Example_First', sexType: '1', dateOfBirth: '1990-01-01' }, language: 'DE', numberOfDays: 1, serviceType: 20, startOfPeriod: '2026-01-06', version: 1 },
    [`${OTHER_ID}/2`]: { businessId: OTHER_ID, endOfPeriod: '2025-06-06', numberOfDays: 3, serviceType: 20, startOfPeriod: '2025-06-04', version: 2 },
  },
  forms: {
    [ID]: {
      activity: { hasIncome: null, hasEndedTrainingRecently: null, employerInSwitzerland: null, hadUnemploymentPeriodsBeforeService: null, activityType: null, activityDetails: null },
      bankAccountDetails: { accountHolderName: 'Example_First Example_Name', accountHolderAddress: 'Example_Street 1, 0000, Example_Town', iban: IBAN, nonIban: false, bankName: null, bankAddress: null, accountNumber: null, swiftCode: null },
      categoryRequirements: [],
      contactDetails: { mobilePhone: '0041' + '790000000', emailAddress: 'person@example.com' },
      familySituation: { children: [], hasChildren: false, hasFosterStepChildren: false, hasFosterStepChildrenOverEighteen: null, hasAdditionalChildcareExpenses: null },
      isServicePeriodValidated: false, servicePeriodVersion: 1, useActivityHistory: null, version: 2,
    },
  },
  attachments: { [ID]: [], [OTHER_ID]: [] },
  employers: [
    { uid: 'CHE000000019', organisationName: 'Example_Bahn AG', town: 'Example_Town', npa: 1000, address: 'Example_Street 1', cantonAbbreviation: 'BE', compensationOffice: 'CHE000000001' },
    { uid: 'CHE000000027', organisationName: 'Example_Bank AG', town: 'Other_Town', npa: 2000, address: 'Example_Street 2', cantonAbbreviation: 'ZH', compensationOffice: 'CHE000000002' },
  ],
  offices: [
    { id: 1000, uid: 'CHE000000001', description: 'AK 1 - Example_Kasse Nord', sedexId: '6-001000-1', version: 0 },
    { id: 2000, uid: 'CHE000000002', description: 'AK 2 - Example_Kasse Süd', sedexId: '6-002000-1', version: 0 },
  ],
  tokens: { '11111111-1111-4111-8111-111111111111': 'SUCCESS_TOKEN', '22222222-2222-4222-8222-222222222222': 'USED_TOKEN' },
  // How the backend answers a browser nobody is logged in with.
  loggedOut: 'redirect',          // 'redirect' | '401' | 'html'
  // The login page logs itself in after this many ms; null = nobody ever does.
  autoLoginAfterMs: null,
  // Ways to disagree with the client.
  putAnswers: null,               // e.g. 409 or 400: refuse the next form write
  putAlters: null,                // fn(form) run on a write before it is stored
  confirmAnswers: null,           // e.g. 500: refuse the confirmation
  confirmKeepsEditing: false,     // accept the confirmation, change nothing
  deleteLies: false,              // answer 204 and keep the attachment
  uploadAnswers: null,            // e.g. 415: refuse the upload
  searchAnswers: null,            // e.g. 504: the register times out
  breakCases: false,              // answer the case list with a 500
  breakPeriod: false,             // answer a period with a 500
  nextAttachmentId: 1,
});

export async function startPortal(overrides = {}) {
  const state = Object.assign(freshState(), overrides);
  const requests = [];

  const send = (res, status, body, headers = {}) => {
    const isJson = body !== undefined && typeof body !== 'string';
    res.writeHead(status, { ...(isJson ? { 'content-type': 'application/json' } : {}), ...headers });
    res.end(isJson ? JSON.stringify(body) : (body ?? ''));
  };
  const problem = (res, status, detail) => {
    res.writeHead(status, { 'content-type': 'application/problem+json' });
    res.end(JSON.stringify({ status, title: 'Problem', detail }));
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://fixture');
      const path = url.pathname;
      const authed = (req.headers.cookie || '').includes(`${COOKIE}=ok`);
      let body = null;
      if (/json/.test(req.headers['content-type'] || '')) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
      requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body, headers: req.headers, authed });

      if (path === '/fake-agov/done') {
        return send(res, 302, '', { 'set-cookie': `${COOKIE}=ok; Path=/`, location: '/home' });
      }
      if (path === '/home' || path === '/login') {
        const auto = !authed && state.autoLoginAfterMs !== null
          ? `<script>setTimeout(() => { location.href = '/fake-agov/done'; }, ${Number(state.autoLoginAfterMs)});</script>` : '';
        return send(res, 200, `<!doctype html><title>${authed ? 'EO-Portal' : 'AGOV Login'}</title><h1>${authed ? 'Perioden' : 'Anmelden'}</h1>${auto}`, { 'content-type': 'text/html; charset=utf-8' });
      }
      if (!path.startsWith('/napg/api/6/')) return send(res, 404, 'not found');

      if (!authed) {
        if (state.loggedOut === '401') return send(res, 401, '');
        if (state.loggedOut === 'html') return send(res, 200, '<!doctype html><title>AGOV Login</title>', { 'content-type': 'text/html' });
        return send(res, 302, '', { location: '/login' });
      }

      const p = path.slice('/napg/api/6'.length);
      let m;
      if (p === '/cases' && req.method === 'GET') {
        return state.breakCases ? problem(res, 500, 'boom') : send(res, 200, state.cases);
      }
      if ((m = /^\/service-periods\/([^/]+)\/([^/]+)$/.exec(p)) && req.method === 'GET') {
        if (state.breakPeriod) return problem(res, 500, 'boom');
        const period = state.periods[`${m[1]}/${m[2]}`];
        return period ? send(res, 200, period) : problem(res, 404, 'no such period');
      }
      if ((m = /^\/cases\/([^/]+)\/form$/.exec(p))) {
        const id = m[1];
        if (req.method === 'GET') {
          if (state.forms[id] === 'broken') return problem(res, 500, 'boom');
          return state.forms[id] ? send(res, 200, state.forms[id]) : send(res, 404, '');
        }
        if (req.method === 'PUT') {
          if (state.putAnswers) return problem(res, state.putAnswers, state.putAnswers === 409 ? 'version conflict' : 'activityType: must not be blank');
          if (!state.forms[id]) return send(res, 404, '');
          if (body.version !== state.forms[id].version) return problem(res, 409, 'version conflict');
          const next = { ...body, version: body.version + 1 };
          if (state.putAlters) state.putAlters(next);
          state.forms[id] = next;
          return send(res, 200, next);
        }
      }
      if ((m = /^\/cases\/([^/]+)\/attachments$/.exec(p))) {
        const id = m[1];
        if (req.method === 'GET') {
          return state.attachments[id] === 'broken' ? problem(res, 500, 'boom') : send(res, 200, { attachments: state.attachments[id] || [] });
        }
        if (req.method === 'POST') {
          if (state.uploadAnswers) return problem(res, state.uploadAnswers, 'unsupported file type');
          const text = raw.toString('latin1');
          const categoryId = /name="categoryId"\r\n\r\n([^\r]+)/.exec(text)?.[1];
          const fileName = /name="attachment"; filename="([^"]+)"/.exec(text)?.[1];
          const attachment = { id: state.nextAttachmentId++, businessId: id, categoryId, fileName, fileSize: raw.length };
          state.attachments[id].push(attachment);
          return send(res, 201, attachment);
        }
      }
      if ((m = /^\/cases\/([^/]+)\/attachments\/([^/]+)$/.exec(p)) && req.method === 'DELETE') {
        if (state.deleteAnswers) return problem(res, state.deleteAnswers, 'no');
        if (!state.deleteLies) state.attachments[m[1]] = state.attachments[m[1]].filter(a => String(a.id) !== m[2]);
        return send(res, 204);
      }
      if ((m = /^\/cases\/([^/]+)\/confirm$/.exec(p)) && req.method === 'POST') {
        if (state.confirmAnswers) return problem(res, state.confirmAnswers, 'cannot confirm');
        const c = state.cases.find(x => x.businessId === m[1]);
        if (!state.confirmKeepsEditing) { c.status = 'ASSIGNED'; c.assignedCompensationOffice = 'CHE000000001'; }
        return send(res, 200, { status: 'ASSIGNED', assignedCompensationOffice: 'CHE000000001' });
      }
      if (p === '/uids' && req.method === 'GET') {
        if (state.searchAnswers) return send(res, state.searchAnswers, '');
        const q = Object.fromEntries(url.searchParams);
        const has = (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase());
        return send(res, 200, state.employers.filter(e =>
          has(e.organisationName, q.organisationName || '')
          && (!q.town || has(e.town, q.town)) && (!q.npa || String(e.npa) === q.npa)
          && (!q.cantonAbbreviation || e.cantonAbbreviation === q.cantonAbbreviation)));
      }
      if ((m = /^\/uids\/([^/]+)$/.exec(p)) && req.method === 'GET') {
        if (state.searchAnswers) return problem(res, state.searchAnswers, 'boom');
        const e = state.employers.find(x => x.uid === m[1]);
        return e ? send(res, 200, e) : send(res, 404, '');
      }
      if (p === '/compensation-offices' && req.method === 'GET') {
        return state.officesAnswer ? problem(res, state.officesAnswer, 'boom') : send(res, 200, state.offices);
      }
      if (p === '/astreints/onboarding' && req.method === 'POST') {
        const result = state.tokens[body?.token];
        return result ? send(res, 200, { status: result }) : problem(res, 400, 'UNKNOWN_TOKEN');
      }
      return send(res, 404, '');
    });
  });
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url, state, requests,
    // Back to the untouched portal, in place: the server under test keeps its
    // base URL, so one of them can serve a whole file of tests.
    reset(next = {}) {
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, freshState(), next);
      requests.length = 0;
    },
    // The requests that reached the backend, without the session probes.
    calls: (method, re) => requests.filter(r => r.method === method && re.test(r.path)),
    // A state.json that carries the fixture's session, so a test starts logged
    // in without anybody opening a window.
    sessionFile(dir) {
      const file = join(dir, 'state.json');
      writeFileSync(file, JSON.stringify({
        cookies: [{ name: COOKIE, value: 'ok', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
        origins: [],
      }));
      return file;
    },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
