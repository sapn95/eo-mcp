<div align="center">

# eo-mcp

Read and fill your **EO claim** (Erwerbsersatz) on the Swiss EO portal. It edits drafts, and submitting needs an explicit confirmation.

[![CI](https://img.shields.io/github/actions/workflow/status/sapn95/eo-mcp/ci.yml?branch=main&style=flat-square&logo=github&logoColor=white&label=CI)](https://github.com/sapn95/eo-mcp/actions/workflows/ci.yml)
&nbsp;
[![licence](https://img.shields.io/github/license/sapn95/eo-mcp?style=flat-square&color=4C5B5C)](LICENSE)

</div>

---

> **Unofficial.** The portal offers no public API. This server talks to the
> JSON backend that the portal's own web client uses, and a portal release can
> change that backend without notice. A change shows up as a failed call, and
> the error carries what the portal answered. Use it for **your own** account
> and respect the portal's terms of use.

An [MCP](https://modelcontextprotocol.io) server for the **EO portal** of the
Central Compensation Office ([eo.zas.admin.ch](https://eo.zas.admin.ch)), where
people who served in the army, in civil protection or in civilian service claim
their loss-of-earnings compensation.

From an MCP client (Claude Code, Claude Desktop and others) you can register
with the confirmation code, list your service periods, read and change the
draft of a claim, look up your employer, attach documents and submit.

## How it works

The portal logs you in through **AGOV**, the login of the Swiss authorities.
That login is interactive and you complete it yourself, once, in a visible
browser window (`eo_login`).

After that the browser is only there to hold the session. Every tool call is an
HTTP request to the portal's backend under `/napg/api/6`, sent with the
browser's cookies. Nothing is clicked and no page is parsed, so a redesign of
the portal's pages does not affect this server. A change to the backend does.

> **Safety:** the server changes **drafts**. A claim reaches the compensation
> office only through `eo_submit` with `confirm: true`. Without it you get a
> dry run that shows the period, the form and the attachments as they would be
> sent, and nothing leaves.

## What has been checked against the real portal

Checked on the live portal on 20 November 2026 (web client 13.4.3, backend
14.0.3), with one civil protection period of an employee:

- `eo_status`, `eo_list_periods`, `eo_get_form`, `eo_search_employers`,
  `eo_compensation_offices`
- the refusal of `eo_update_form` and `eo_submit` on a claim that is already
  with the compensation office
- attaching to a running browser through `EO_CDP_URL`

Checked only against the fixture portal in `test/`, which answers in the shapes
recorded from the real one: `eo_login`, `eo_register`, the `not_registered`
status, a successful `eo_update_form`, the attachment tools and a confirmed
`eo_submit`. The endpoints, the request bodies and the answers the fixture
gives for these come from reading the portal's web client. Until someone
has run them on a live draft, read the form back with `eo_get_form` after a
change, and look at the dry run before you confirm.

Only the employee case has been seen end to end. Students, the self-employed
and the unemployed have their own fields in `activity.activityDetails`, and
this server does not know them. `eo_update_form` passes on what you give it and
the portal validates it.

## Prerequisites

- **Node.js 20.19 or later**
- A Chromium-based browser. An installed Chrome, Edge or Brave is preferred
  over Playwright's own Chromium, which cannot reach the platform
  authenticator, so AGOV offers no passkey there. Only the default macOS
  install locations are searched. Anywhere else, set `EO_BROWSER` to the
  absolute path of the browser, or install Playwright's Chromium.

```bash
git clone https://github.com/sapn95/eo-mcp.git
cd eo-mcp
npm install
npx playwright install chromium   # only if no Chrome, Edge or Brave is found
```

## Register in Claude Code

```bash
claude mcp add eo -- node /absolute/path/to/eo-mcp/index.js
```

Or in an MCP client configuration:

```json
{
  "mcpServers": {
    "eo": { "command": "node", "args": ["/absolute/path/to/eo-mcp/index.js"] }
  }
}
```

## First use

1. `eo_login` opens a browser window. Log in with AGOV. The tool waits up to
   eight minutes and returns once the portal itself answers as logged in.
2. On a new account the status is `not_registered`. Call `eo_register` with
   the confirmation code from the mail or SMS «Registrierung auf dem
   EO-Portal».
3. `eo_list_periods` now shows your periods with their `business_id`.
4. Open the period once in the portal. The portal's web client creates the
   form on first opening, and this server does not create one.
5. `eo_get_form`, then `eo_update_form`, then `eo_submit` without `confirm` to
   see the dry run.

## Session

The session lives in a browser profile under `~/.eo-mcp/profile`. A persistent
profile drops session cookies when the browser closes, so after each
successful call the session is also written to `~/.eo-mcp/state.json` and read
back on the next start. Both are created for your user only (`0700` and
`0600`), because a session cookie is as good as your login.

An expired session comes back as `{"status": "login_required"}` from every
tool. Call `eo_login` again. An account the portal has no claimant for yet
comes back as `{"status": "not_registered"}`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `EO_PROFILE` | `~/.eo-mcp/profile` | Browser profile. Empty: a throwaway profile. The session is still cached unless `EO_STATE` is empty too. |
| `EO_STATE` | `~/.eo-mcp/state.json` | Session cache. Empty: the session is not cached. |
| `EO_BROWSER` | first installed of Chrome, Chrome Canary, Edge, Brave | `chrome`, `chrome-canary`, `edge`, `brave`, `chromium` or an absolute path. |
| `EO_CDP_URL` | unset | Attach to a browser that already runs with `--remote-debugging-port`, for example `http://127.0.0.1:9222`, and use its session. Nothing is cached, and the browser keeps running when the server stops. |
| `EO_LANGUAGE` | `de` | `de`, `fr` or `it`. The language of the office list and of the portal's confirmation. |
| `EO_BASE_URL` | `https://eo.zas.admin.ch` | For the test suite, which points it at a local fixture. |

`EO_CDP_URL` is for the case where you are already logged in to the portal in
your own browser. A debugging port gives every local process control of that
browser, so open it only for as long as you need it.

## Tools

### Session

| Tool | What it does |
| --- | --- |
| `eo_status` | `ok`, `login_required` or `not_registered`. |
| `eo_login` | Opens the login window and waits until the portal answers as logged in. |
| `eo_register` | Sends the confirmation code and returns the periods. A refused code comes back with the portal's reason, for example `USED_TOKEN`, `EXPIRED_TOKEN` or `UNKNOWN_TOKEN`. |

### Reading

| Tool | What it does |
| --- | --- |
| `eo_list_periods` | Each period with `business_id`, case status and the period as the service organisation reported it. |
| `eo_get_form` | The stored form, the attachments, and the required attachment categories that are still missing. |
| `eo_search_employers` | The employer register, by `name` (with optional `zip`, `town`, `canton`) or by `uid`. |
| `eo_compensation_offices` | The compensation offices, with an optional `query`. |

Case status: `EDITING` is a draft you can still change. `ASSIGNED` means the
claim is with the compensation office. The others are `INITIATED`,
`READY_FOR_ASTREINT`, `PAPER`, `CLOSED`, `PRESCRIBED`, `ARCHIVED` and `ERROR`.

### Changing the draft

| Tool | What it does |
| --- | --- |
| `eo_update_form` | Lays `changes` over the stored form and writes it back. |
| `eo_upload_attachment` | Attaches a file of at most 5 MB under a category. |
| `eo_delete_attachment` | Removes one attachment by id, from a draft only. |

`eo_update_form` merges objects key by key. Any other value replaces what was
there, including an array and `null`. The portal uses `null` for «not
answered», so it is written as a value and the key stays.

```json
{
  "business_id": "00000000001_00000000002_1",
  "changes": {
    "isServicePeriodValidated": true,
    "familySituation": { "hasChildren": false }
  }
}
```

An employee, in the shape the portal stores. Take the employer from
`eo_search_employers`:

```json
{
  "activity": {
    "hasIncome": true,
    "employerInSwitzerland": true,
    "activityType": "EMPLOYEE",
    "activityDetails": {
      "_type": "ActivityEmployee",
      "employer": {
        "uid": "CHE000000019",
        "organisationName": "Example AG",
        "town": "Example",
        "npa": 1000,
        "address": null,
        "cantonAbbreviation": "BE",
        "compensationOffice": { "uid": "CHE000000001", "notFound": false, "accountNumber": null },
        "notFound": false,
        "byUid": true,
        "farmingAllowance": false
      },
      "otherEmployer": []
    }
  }
}
```

What the tool guards:

- Only a case in status `EDITING` is written to.
- The write carries the `version` that was read. If the form changed elsewhere
  in between, the portal answers with a conflict and nothing is overwritten.
- `version`, `servicePeriodVersion` and `categoryRequirements` belong to the
  portal and are refused in `changes`.
- The stored form is read back and compared with what you asked for. A value
  the portal kept differently is listed under `differing`.

### Submitting

| Tool | What it does |
| --- | --- |
| `eo_submit` | Without `confirm: true` a dry run. With it, the claim goes to the compensation office. This cannot be undone. |

`eo_submit` refuses, with or without `confirm`, when the case is not in status
`EDITING`, when the period has not been confirmed as correct, when no activity
is chosen, or when a required attachment is missing. After a confirmed call it
asks the portal for the case list again and reports `submitted: true` only if
the case is no longer in `EDITING` there.

## Troubleshooting

- `login_required` right after `eo_login`: the login was not finished in the
  window. Call `eo_login` again.
- `not_registered`: the login worked, but the account has no claimant yet.
  Use `eo_register` with the confirmation code.
- `Für diese Periode gibt es noch kein Formular`: open the period once in the
  portal.
- `EO_BROWSER="…" not found`: the path or name does not exist on this machine.
- The portal refuses a change: its answer is under `portal`, in the portal's
  own words.

## Checks

```bash
npm run gate
```

This runs the syntax check, ESLint, an offline protocol smoke test, the hygiene
scan and the test suite with a coverage floor. The suite drives the server
over stdio against the fixture portal in `test/fixture-portal.mjs`, through a
real headless browser. The fixture holds invented data only.

The hygiene scan fails on secrets, personal data and tracked session files. A
claim form holds an IBAN, a social-security number and an address, and none of
that belongs in a public repository.

## License

MIT
