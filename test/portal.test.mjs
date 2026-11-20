// The server against the fixture portal, through a real browser: reading the
// periods and the form, changing the draft, attachments, and the one
// irreversible call.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './client.mjs';
import { startPortal, ID, OTHER_ID, IBAN } from './fixture-portal.mjs';

let portal, srv;
const dir = mkdtempSync(join(tmpdir(), 'eo-portal-'));
before(async () => {
  portal = await startPortal();
  srv = await startServer({ EO_BASE_URL: portal.url, EO_STATE: portal.sessionFile(dir) });
});
// Each on its own: a server that never started, or one that will not stop,
// must not leave the portal's listener open.
after(async () => { try { await srv?.stop(); } finally { await portal?.close(); } });
beforeEach(() => portal.reset());

const call = async (name, args) => (await srv.call(name, args));
const data = async (name, args) => (await call(name, args)).data;
// A draft with everything eo_submit asks for.
const complete = () => {
  portal.state.forms[ID].isServicePeriodValidated = true;
  portal.state.forms[ID].activity.activityType = 'EMPLOYEE';
};

describe('reading', () => {
  test('the session is reported alive, with the header the portal client sends', async () => {
    assert.deepEqual(await data('eo_status'), { status: 'ok' });
    const probe = portal.calls('GET', /\/cases$/)[0];
    assert.equal(probe.headers['x-requested-with'], 'XMLHttpRequest');
  });

  test('periods come with their case status and the period the case names', async () => {
    const { periods, hint } = await data('eo_list_periods');
    assert.equal(hint, undefined);
    assert.deepEqual(periods.map(p => [p.business_id, p.status, p.status_text]), [
      [ID, 'EDITING', 'zu ergänzen'],
      [OTHER_ID, 'ASSIGNED', 'eingereicht, bei der Ausgleichskasse'],
    ]);
    assert.equal(periods[0].period.numberOfDays, 1);
    assert.equal(periods[0].period.iban, IBAN);
    // Version 2 of the second period, because that is the one its case names.
    assert.equal(periods[1].period.numberOfDays, 3);
    assert.equal(periods[1].compensation_office, 'CHE000000001');
  });

  test('a period that cannot be read is reported as unread, not dropped', async () => {
    portal.state.breakPeriod = true;
    const { periods } = await data('eo_list_periods');
    assert.equal(periods.length, 2);
    assert.equal(periods[0].period, null);
    assert.equal(periods[0].period_error.http, 500);
    assert.equal(periods[0].period_error.portal.detail, 'boom');
  });

  test('an account without periods says so', async () => {
    portal.state.cases = [];
    const r = await data('eo_list_periods');
    assert.deepEqual(r.periods, []);
    assert.match(r.hint, /keine Perioden/);
  });

  test('an account the portal has no claimant for is not_registered, from every tool', async () => {
    portal.state.registered = false;
    assert.equal((await data('eo_status')).status, 'not_registered');
    for (const [name, args] of [['eo_list_periods', {}], ['eo_get_form', { business_id: ID }], ['eo_submit', { business_id: ID, confirm: true }]]) {
      const r = await call(name, args);
      assert.equal(r.data.status, 'not_registered', name);
      assert.match(r.data.message, /eo_register/, name);
      assert.ok(!r.isError, name);
    }
  });

  test('a case list the portal fails to serve is an error, not an empty list', async () => {
    portal.state.breakCases = true;
    const { raw, isError } = await call('eo_list_periods');
    assert.ok(isError);
    assert.match(raw, /Fallübersicht liess sich nicht lesen \(HTTP 500\)/);
  });

  test('the form comes with its attachments and what is still missing', async () => {
    portal.state.forms[ID].categoryRequirements = [
      { categoryId: 'CHOMAGE_001', isRequired: true, attachmentsCount: 0 },
      { categoryId: 'FEUCOMP_003', isRequired: false, attachmentsCount: 0 },
      { categoryId: 'ATTFORMAST_001', isRequired: true, attachmentsCount: 0 },
    ];
    portal.state.attachments[ID] = [{ id: 7, categoryId: 'ATTFORMAST_001', fileName: 'Example.pdf' }];
    const r = await data('eo_get_form', { business_id: ID });
    assert.equal(r.status, 'EDITING');
    assert.equal(r.form.version, 2);
    assert.equal(r.attachments.length, 1);
    assert.deepEqual(r.missing_attachments, [{ category: 'CHOMAGE_001', name: 'Abrechnung der Leistungen der Arbeitslosenversicherung' }]);
  });

  test('a period nobody has opened yet has no form, and says how one comes to be', async () => {
    delete portal.state.forms[ID];
    const r = await data('eo_get_form', { business_id: ID });
    assert.equal(r.form, null);
    assert.match(r.hint, /im Portal geöffnet/);
    assert.deepEqual(r.missing_attachments, []);
  });

  test('an id the account does not have names the ones it does', async () => {
    const { raw, isError } = await call('eo_get_form', { business_id: '9_9_9' });
    assert.ok(isError);
    assert.match(raw, new RegExp(`Keine Periode mit der Fall-ID 9_9_9 — vorhanden: ${ID}, ${OTHER_ID}`));
    portal.state.cases = [];
    assert.match((await call('eo_get_form', { business_id: '9_9_9' })).raw, /führt für dieses Konto keine Perioden/);
  });

  test('a form or attachment list the portal fails to serve is an error', async () => {
    portal.state.forms[ID] = 'broken';
    assert.match((await call('eo_get_form', { business_id: ID })).raw, /Formular liess sich nicht lesen \(HTTP 500\)/);
    portal.reset();
    portal.state.attachments[ID] = 'broken';
    assert.match((await call('eo_get_form', { business_id: ID })).raw, /Beilagen liessen sich nicht lesen \(HTTP 500\)/);
  });
});

describe('the employer register and the compensation offices', () => {
  test('a search by name passes the filters on under the portal\'s names', async () => {
    const r = await data('eo_search_employers', { name: 'example_b', zip: '1000', town: 'Example_Town', canton: 'be' });
    assert.deepEqual(r.employers.map(e => e.uid), ['CHE000000019']);
    assert.deepEqual(portal.calls('GET', /\/uids$/)[0].query, { organisationName: 'example_b', npa: '1000', town: 'Example_Town', cantonAbbreviation: 'BE' });
    assert.equal((await data('eo_search_employers', { name: 'Example_B' })).employers.length, 2);
  });

  test('a uid is looked up whatever punctuation it comes in', async () => {
    for (const uid of ['CHE-000.000.019', 'CHE000000019', '000000019']) {
      assert.deepEqual((await data('eo_search_employers', { uid })).employers.map(e => e.organisationName), ['Example_Bahn AG'], uid);
    }
    const none = await data('eo_search_employers', { uid: 'CHE-999.999.999' });
    assert.deepEqual(none.employers, []);
    assert.match(none.hint, /keine UID CHE999999999/);
  });

  test('a register that times out or fails says so', async () => {
    portal.state.searchAnswers = 504;
    assert.match((await data('eo_search_employers', { name: 'x' })).error, /zu lange gedauert/);
    portal.state.searchAnswers = 500;
    assert.match((await data('eo_search_employers', { name: 'x' })).error, /fehlgeschlagen/);
    const byUid = await data('eo_search_employers', { uid: '000000019' });
    assert.match(byUid.error, /nicht nachschlagen/);
    assert.equal(byUid.http, 500);
  });

  test('the offices are listed, and filtered by description or uid', async () => {
    assert.equal((await data('eo_compensation_offices')).offices.length, 2);
    assert.equal(portal.calls('GET', /compensation-offices/)[0].query.lang, 'de');
    const byText = await data('eo_compensation_offices', { query: 'süd' });
    assert.deepEqual(byText.offices.map(o => o.id), [2000]);
    assert.equal(byText.of, 2);
    assert.deepEqual((await data('eo_compensation_offices', { query: 'CHE-000.000.001' })).offices.map(o => o.id), [1000]);
    portal.state.officesAnswer = 500;
    assert.match((await data('eo_compensation_offices')).error, /Ausgleichskassen liess sich nicht lesen/);
  });
});

describe('changing the draft', () => {
  test('changes are merged into the stored form and sent with the version that was read', async () => {
    const employer = { uid: 'CHE000000019', organisationName: 'Example_Bahn AG' };
    const r = await data('eo_update_form', {
      business_id: ID,
      changes: { isServicePeriodValidated: true, activity: { hasIncome: true, activityType: 'EMPLOYEE', activityDetails: { employer } }, familySituation: { children: [] } },
    });
    assert.equal(r.updated, true);
    assert.equal(r.warning, undefined);
    const put = portal.calls('PUT', /\/form$/)[0].body;
    assert.equal(put.version, 2);
    assert.equal(put.activity.activityType, 'EMPLOYEE');
    assert.deepEqual(put.activity.activityDetails, { employer });
    // What was not mentioned is still there, nulls included.
    assert.equal(put.activity.employerInSwitzerland, null);
    assert.equal(put.bankAccountDetails.iban, IBAN);
    assert.equal(put.familySituation.hasChildren, false);
    assert.equal(r.form.version, 3);
    assert.equal(portal.state.forms[ID].isServicePeriodValidated, true);
  });

  test('null is a value, and an array replaces the one that was there', async () => {
    portal.state.forms[ID].familySituation.children = [{ firstName: 'Example_Child' }];
    portal.state.forms[ID].activity.activityType = 'STUDENT';
    const r = await data('eo_update_form', { business_id: ID, changes: { activity: { activityType: null }, familySituation: { children: [] } } });
    assert.equal(r.updated, true);
    const put = portal.calls('PUT', /\/form$/)[0].body;
    assert.equal(put.activity.activityType, null);
    assert.ok(Object.hasOwn(put.activity, 'activityType'));
    assert.deepEqual(put.familySituation.children, []);
  });

  test('a value the portal stores differently is reported, not passed off as set', async () => {
    portal.state.putAlters = f => { f.contactDetails.mobilePhone = '0041' + '791111111'; };
    const r = await data('eo_update_form', { business_id: ID, changes: { contactDetails: { mobilePhone: '0041 79 222 22 22' }, isServicePeriodValidated: true } });
    assert.equal(r.updated, true);
    assert.match(r.warning, /nicht alle Werte/);
    assert.deepEqual(r.differing, [{ field: 'contactDetails.mobilePhone', asked: '0041 79 222 22 22', kept: '0041' + '791111111' }]);
  });

  test('a version conflict and a refusal both leave the form alone and say why', async () => {
    portal.state.putAnswers = 409;
    const conflict = await data('eo_update_form', { business_id: ID, changes: { isServicePeriodValidated: true } });
    assert.equal(conflict.updated, false);
    assert.match(conflict.error, /Versionskonflikt/);
    portal.state.putAnswers = 400;
    const refused = await data('eo_update_form', { business_id: ID, changes: { isServicePeriodValidated: true } });
    assert.equal(refused.updated, false);
    assert.equal(refused.http, 400);
    assert.match(refused.portal.detail, /activityType/);
    assert.equal(portal.state.forms[ID].isServicePeriodValidated, false);
  });

  test('only a draft is changed', async () => {
    const r = await data('eo_update_form', { business_id: OTHER_ID, changes: { isServicePeriodValidated: true } });
    assert.equal(r.updated, false);
    assert.equal(r.status, 'ASSIGNED');
    assert.match(r.error, /nur ein Antrag im Status EDITING/);
    assert.equal(portal.calls('PUT', /./).length, 0);
  });

  test('a period without a form gets none invented', async () => {
    delete portal.state.forms[ID];
    const r = await data('eo_update_form', { business_id: ID, changes: { isServicePeriodValidated: true } });
    assert.equal(r.updated, false);
    assert.match(r.error, /noch kein Formular/);
    assert.equal(portal.calls('PUT', /./).length + portal.calls('POST', /./).length, 0);
  });

  test('changes that are no changes, or reach for the portal\'s own fields, are refused unsent', async () => {
    for (const changes of [undefined, null, 'x', [], {}]) {
      assert.match((await call('eo_update_form', { business_id: ID, changes })).raw, /changes muss ein Objekt/, JSON.stringify(changes));
    }
    for (const key of ['version', 'servicePeriodVersion', 'categoryRequirements']) {
      assert.match((await call('eo_update_form', { business_id: ID, changes: { [key]: 1 } })).raw, new RegExp(`darf ${key} nicht setzen`));
    }
    const proto = await call('eo_update_form', { business_id: ID, changes: JSON.parse('{"activity":{"__proto__":{"x":1}}}') });
    assert.match(proto.raw, /darf den Schlüssel "__proto__" nicht enthalten/);
    assert.equal(portal.calls('PUT', /./).length, 0);
  });
});

describe('attachments', () => {
  const file = join(dir, 'Example_Beleg.pdf');
  writeFileSync(file, '%PDF-1.4 example');

  test('a file is uploaded under its category and then listed', async () => {
    const r = await data('eo_upload_attachment', { business_id: ID, category: 'DIVERS_001', file });
    assert.equal(r.uploaded, true);
    assert.equal(r.attachment.categoryId, 'DIVERS_001');
    assert.equal(r.attachment.fileName, 'Example_Beleg.pdf');
    assert.deepEqual(r.attachments.map(a => a.id), [1]);
  });

  test('an upload the portal refuses is not reported as there', async () => {
    portal.state.uploadAnswers = 415;
    const r = await data('eo_upload_attachment', { business_id: ID, category: 'DIVERS_001', file });
    assert.equal(r.uploaded, false);
    assert.equal(r.http, 415);
    assert.match(r.portal.detail, /unsupported file type/);
  });

  test('nothing is attached to a claim that is no longer a draft', async () => {
    const r = await data('eo_upload_attachment', { business_id: OTHER_ID, category: 'DIVERS_001', file });
    assert.equal(r.uploaded, false);
    assert.equal(portal.calls('POST', /attachments/).length, 0);
  });

  test('an empty file and one over 5 MB never leave the machine', async () => {
    const empty = join(dir, 'Example_Leer.pdf'); writeFileSync(empty, '');
    const big = join(dir, 'Example_Gross.pdf'); writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1));
    assert.match((await call('eo_upload_attachment', { business_id: ID, category: 'DIVERS_001', file: empty })).raw, /ist leer/);
    assert.match((await call('eo_upload_attachment', { business_id: ID, category: 'DIVERS_001', file: big })).raw, /grösser als 5 MB/);
    assert.equal(portal.requests.length, 0);
  });

  test('an attachment is deleted by id, and only one the period has', async () => {
    portal.state.attachments[ID] = [{ id: 4, categoryId: 'DIVERS_001', fileName: 'Example_A.pdf' }, { id: 5, categoryId: 'DIVERS_001', fileName: 'Example_B.pdf' }];
    portal.state.attachments[OTHER_ID] = [{ id: 8, categoryId: 'DIVERS_001', fileName: 'Example_C.pdf' }];
    const submitted = await data('eo_delete_attachment', { business_id: OTHER_ID, attachment_id: '8' });
    assert.equal(submitted.deleted, false);
    assert.equal(submitted.status, 'ASSIGNED');
    const wrong = await data('eo_delete_attachment', { business_id: ID, attachment_id: '9' });
    assert.equal(wrong.deleted, false);
    assert.equal(portal.calls('DELETE', /./).length, 0);
    const r = await data('eo_delete_attachment', { business_id: ID, attachment_id: '4' });
    assert.equal(r.deleted, true);
    assert.deepEqual(r.attachments.map(a => a.id), [5]);
  });

  test('a delete the portal confirms but does not do is not reported as done', async () => {
    portal.state.attachments[ID] = [{ id: 4, categoryId: 'DIVERS_001', fileName: 'Example_A.pdf' }];
    portal.state.deleteLies = true;
    const lied = await data('eo_delete_attachment', { business_id: ID, attachment_id: '4' });
    assert.equal(lied.deleted, false);
    assert.match(lied.error, /führt die Beilage aber weiterhin/);
    portal.state.deleteLies = false;
    portal.state.deleteAnswers = 403;
    const refused = await data('eo_delete_attachment', { business_id: ID, attachment_id: '4' });
    assert.equal(refused.deleted, false);
    assert.equal(refused.http, 403);
  });
});

describe('registration', () => {
  test('a code the portal accepts registers the account, and the periods show it', async () => {
    portal.state.registered = false;
    assert.equal((await data('eo_status')).status, 'not_registered');
    const r = await data('eo_register', { code: ' 11111111-1111-4111-8111-111111111111 ' });
    assert.equal(r.registered, true);
    assert.equal(r.periods.length, 2);
    assert.equal((await data('eo_status')).status, 'ok');
    assert.deepEqual(portal.calls('POST', /onboarding/)[0].body, { token: '11111111-1111-4111-8111-111111111111', language: 'de' });
  });

  test('a code the portal refuses is not a registration, and its reason is named', async () => {
    for (const [code, reason] of [['33333333-3333-4333-8333-333333333333', 'UNKNOWN_TOKEN'], ['22222222-2222-4222-8222-222222222222', 'USED_TOKEN']]) {
      const r = await data('eo_register', { code });
      assert.equal(r.registered, false);
      assert.equal(r.reason, reason);
      assert.equal(r.http, 400);
    }
    portal.state.onboardingAnswers = 500;
    const broken = await data('eo_register', { code: '11111111-1111-4111-8111-111111111111' });
    assert.equal(broken.registered, false);
    assert.equal(broken.reason, undefined);
    assert.equal(broken.http, 500);
  });
});

describe('submitting', () => {
  test('without confirm:true nothing is sent, and the claim is shown as it would go', async () => {
    complete();
    for (const confirm of [undefined, false, 'true', 1]) {
      const r = await data('eo_submit', { business_id: ID, confirm });
      assert.equal(r.dry_run, true, String(confirm));
      assert.equal(r.submitted, undefined);
      assert.equal(r.period.numberOfDays, 1);
      assert.equal(r.form.activity.activityType, 'EMPLOYEE');
    }
    assert.equal(portal.calls('POST', /confirm/).length, 0);
    assert.equal(portal.state.cases[0].status, 'EDITING');
  });

  test('a confirmed call submits, and reports the status the case list shows afterwards', async () => {
    complete();
    const r = await data('eo_submit', { business_id: ID, confirm: true });
    assert.deepEqual(r, { submitted: true, business_id: ID, status: 'ASSIGNED', status_text: 'eingereicht, bei der Ausgleichskasse', compensation_office: 'CHE000000001' });
    assert.deepEqual(portal.calls('POST', /confirm/).map(c => [c.path, c.body]), [[`/napg/api/6/cases/${ID}/confirm`, { language: 'de' }]]);
  });

  test('an incomplete claim is refused, confirm:true and all, and says what is open', async () => {
    portal.state.forms[ID].categoryRequirements = [{ categoryId: 'CHOMAGE_001', isRequired: true, attachmentsCount: 0 }];
    const r = await data('eo_submit', { business_id: ID, confirm: true });
    assert.equal(r.submitted, false);
    assert.equal(r.incomplete.length, 3);
    assert.match(r.incomplete[0], /isServicePeriodValidated/);
    assert.match(r.incomplete[1], /activity\.activityType/);
    assert.match(r.incomplete[2], /Pflichtbeilage fehlt: CHOMAGE_001/);
    assert.equal(portal.calls('POST', /confirm/).length, 0);
  });

  test('a case that is past the draft is never confirmed a second time', async () => {
    const r = await data('eo_submit', { business_id: OTHER_ID, confirm: true });
    assert.equal(r.submitted, false);
    assert.equal(r.already_submitted, true);
    portal.state.cases[0].status = 'PAPER';
    const paper = await data('eo_submit', { business_id: ID, confirm: true });
    assert.equal(paper.submitted, false);
    assert.equal(paper.already_submitted, undefined);
    assert.equal(portal.calls('POST', /confirm/).length, 0);
  });

  test('a period without a form is not confirmed', async () => {
    delete portal.state.forms[ID];
    const r = await data('eo_submit', { business_id: ID, confirm: true });
    assert.equal(r.submitted, false);
    assert.match(r.error, /noch kein Formular/);
    assert.equal(portal.calls('POST', /confirm/).length, 0);
  });

  test('a confirmation the portal refuses is not a submission', async () => {
    complete();
    portal.state.confirmAnswers = 500;
    const r = await data('eo_submit', { business_id: ID, confirm: true });
    assert.equal(r.submitted, false);
    assert.equal(r.http, 500);
    assert.match(r.error, /nicht eingereicht/);
  });

  test('a confirmation the portal accepts and does not act on is not a submission', async () => {
    complete();
    portal.state.confirmKeepsEditing = true;
    const r = await data('eo_submit', { business_id: ID, confirm: true });
    assert.equal(r.submitted, false);
    assert.deepEqual(r.portal, { status: 'ASSIGNED', assignedCompensationOffice: 'CHE000000001' });
    assert.match(r.error, /weiterhin als nicht eingereicht/);
  });
});
