# Job Application Tracker (Gmail → Google Sheets)

A Google Apps Script project that reads your recruiting emails in Gmail and keeps a Google Sheet of your
**Spring 2027 and Summer 2027** internship and co-op applications up to date. It runs on Google's servers on a
timer, so it keeps working when your computer is off. You write and test the code locally in VS Code and upload
it with [`clasp`](https://github.com/google/clasp).

The MVP is rules and regular expressions only. No paid AI API is needed.

---

## 1. How it works

```
Gmail search (phrases, recruiting senders, your include label)
   │  read-only, includes archived mail, ignores unread status
   ▼
GmailReader ──► EmailParser ──► SyncPlanner ──► SheetRepository
 (messages)     (company, role,   (match + status    (Applications, Events,
                 req ID, term,     decisions:         Review Queue, Sync Log)
                 event, dates)     CREATE / UPDATE /
                                   REVIEW / IGNORE / SKIP)
                      ▲                 ▲
              TermDetector    ApplicationMatcher + StatusEngine
```

Each sync goes through Gmail in **time windows**. For each window:

1. Read every message in the matching threads. Messages are handled one at a time, not per thread.
2. Skip message IDs that are already in **Events**. This prevents duplicates.
3. Parse each message, then decide what it means.
4. Write the events first, as `PENDING`, `REVIEW` or `IGNORED`, plus any review rows.
5. Apply the `PENDING` events to **Applications**, then mark them `COMPLETED`.
6. Only then save the checkpoint ("processed through time X").

If a run stops partway (timeout, error, quota), the next run first re-applies any leftover `PENDING` events.
Applying an event is idempotent, so doing it twice is harmless. It then re-reads the unfinished window, and
message-ID deduplication keeps that from creating duplicates. Separate Sheets writes are **not** an atomic
transaction. Recovery relies on the event states and on idempotent re-application.

### Folder structure

```
job-tracker/
├── src/                     ← everything here is uploaded by `clasp push`
│   ├── appsscript.json      manifest: V8 runtime, time zone, OAuth scopes
│   ├── Main.js              entry points you run: setup, syncNow, dryRun, ... + menu
│   ├── Config.js            defaults + Script Properties overrides
│   ├── Util.js              dates, normalization, formula escaping          (pure)
│   ├── TermDetector.js      hiring-term detection and eligibility           (pure)
│   ├── EmailParser.js       rule/regex extraction + LLM extension hook      (pure)
│   ├── ApplicationMatcher.js which application an email belongs to          (pure)
│   ├── StatusEngine.js      status rules, idempotent                        (pure)
│   ├── SyncPlanner.js       per-message decisions, event application        (pure)
│   ├── SyncState.js         checkpoint window math (pure) + PropertiesService
│   ├── GmailReader.js       GmailApp (read-only)
│   ├── SheetRepository.js   SpreadsheetApp
│   ├── ReviewService.js     Review Queue decisions
│   └── SyncService.js       orchestration, LockService, recovery, dry run
├── tests/                   ← local only, never uploaded
│   ├── helpers/load.js      loads src/ into one global scope (like Apps Script)
│   ├── helpers/fakes.js     in-memory Gmail/Sheets/Properties/Lock/Script fakes
│   ├── fixtures/emails.js   synthetic emails
│   └── *.test.js
├── package.json  jsconfig.json  .gitignore  .clasp.json.example
```

Apps Script loads every file into **one shared global scope**; there are no `import`/`require` statements.
Each module is a `var Name = (function () { ... })()` object. Modules only use each other inside functions,
so the order files load in doesn't matter.

---

## 2. What runs where

| Where | What | Examples |
|---|---|---|
| **Your computer (terminal)** | Node.js tests, `clasp` commands | `npm test`, `clasp login`, `clasp push` |
| **Google's servers (Apps Script)** | Everything that uses `GmailApp`, `SpreadsheetApp`, `PropertiesService`, `LockService`, `ScriptApp` | `setup`, `syncNow`, `dryRun`, `processReviewDecisions`, `installTrigger`, `scheduledSync` |

Built-in Apps Script services **do not exist in Node.js**. Locally, the tests run the pure modules for real
and swap the Google services for the in-memory fakes in `tests/helpers/fakes.js`. Passing local tests means
the logic is right against those fakes. It does **not** prove the real Gmail and Sheets behave the same way;
see [Limitations](#9-limitations).

You run Apps Script functions from the **Apps Script editor** (choose the function, then **Run**) or from the
spreadsheet's **Job Tracker** menu. `clasp run-function` also exists, but it needs an extra Google Cloud
setup, so this guide doesn't use it.

---

## 3. Setup

I verified these commands against `@google/clasp` **3.4.1** (latest on npm on 2026-11-02) using its
`--help` output and README. I did **not** run them against a Google account; you'll be the first.

### 3.1 Install tools (local)

```sh
node --version              # Node 22+ for the tests (clasp itself needs 20+)
npm install -g @google/clasp
clasp --version             # expect 3.x
cd job-tracker
npm install                 # optional: only installs Apps Script type hints for VS Code
npm test                    # local tests, no Google account needed
```

### 3.2 Enable the Apps Script API (one time, in a browser)

Open <https://script.google.com/home/usersettings> and turn **Google Apps Script API** on. `clasp` can't
create or push projects until you do.

### 3.3 Log in (local)

```sh
clasp login
```

This opens a browser for Google sign-in. Your token is saved in `~/.clasprc.json` in your **home folder**,
outside this repo. Never commit or share that file. Use `clasp show-authorized-user` to check who is
logged in, and `clasp logout` to remove the token.

### 3.4 Create the spreadsheet + bound script (local)

`clasp create-script` downloads the new project's starter files into `--rootDir`. If you pointed it at `src/`,
it would overwrite this project's `appsscript.json`. So create the project into a throwaway folder, then
point `rootDir` back at `src`:

```sh
clasp create-script --type sheets --title "Job Application Tracker" --rootDir clasp-init
node -e "const f='.clasp.json',c=JSON.parse(require('fs').readFileSync(f));c.rootDir='src';require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
rm -rf clasp-init
clasp show-file-status      # should list src/appsscript.json and the src/*.js files only
```

This creates a new Google Sheet named "Job Application Tracker" in your Drive, with a script bound to it.
Bound means the script belongs to that spreadsheet.

**Already have a spreadsheet?** Open it, then go to **Extensions → Apps Script → Project Settings → Script ID**.
Then run:

```sh
clasp clone-script <SCRIPT_ID> --rootDir clasp-init
# then the same two commands as above (fix rootDir, delete clasp-init)
```

### 3.5 Upload the code (local)

```sh
clasp push
```

clasp will ask whether to overwrite the remote manifest. Answer **yes**: that uploads this project's scopes and
time zone. `push` replaces the remote files with the files in `src/`, so the starter `Code.gs` is removed.
Edit `"timeZone"` in `src/appsscript.json` first if you aren't on US Eastern time.

### 3.6 Authorize (Apps Script editor)

```sh
clasp open-script           # opens the Apps Script editor
```

1. In the function dropdown, choose **`setup`**, then click **Run**.
2. Google shows *Authorization required*. Click **Review permissions** and choose your account.
3. You'll probably see *"Google hasn't verified this app"*. That's normal for a script you wrote yourself.
   Click **Advanced → Go to Job Application Tracker (unsafe)**.
4. If Google lists the permissions with checkboxes, tick **all** of them, then click **Allow**.

`setup` creates the tabs and writes the default settings into **Project Settings → Script Properties**.

### 3.7 Configure, preview, then sync

1. In **Project Settings → Script Properties**, set `INITIAL_IMPORT_START` to a date early enough to
   catch your oldest Spring/Summer 2027 confirmations, for example `2026-01-01`.
2. Reload the spreadsheet. A **Job Tracker** menu appears.
3. Run **Job Tracker → Dry run (preview only)** and read the **Dry Run Preview** tab. The dry run
   changes nothing except that tab and one line in Sync Log.
4. Run **Job Tracker → Sync now**. A large first import can take several runs; each run continues where the
   last one stopped. Watch **Sync Log**.
5. Run **Job Tracker → Install / update automatic sync**. The default schedule is every 2 hours.

Running a menu item for the first time from the sheet may ask you to authorize again. That's expected.

---

## 4. Daily use

| Menu item / function | Runs in | What it does |
|---|---|---|
| `setup` | Apps Script | Creates/repairs tabs and columns, adds missing default settings. Safe to rerun. |
| `syncNow` | Apps Script | One sync run. Recovers interrupted work first. |
| `dryRun` | Apps Script | Previews decisions into **Dry Run Preview**. Doesn't touch Applications/Events/Review Queue or the checkpoint. |
| `processReviewDecisions` | Apps Script | Applies decisions you entered in **Review Queue**. |
| `installTrigger` | Apps Script | Deletes any existing `scheduledSync` triggers, then creates one. Running it repeatedly still leaves exactly one schedule. |
| `removeTriggers` | Apps Script | Turns automation off. |
| `showSyncStatus` | Apps Script | Shows the checkpoint and how many triggers exist. |
| `resetSyncCheckpoint` | Apps Script | Re-reads Gmail from `INITIAL_IMPORT_START`. Deduplication means no duplicates are created. |
| `scheduledSync` | Trigger | What the timer calls. Same as `syncNow`. |

### Review workflow

Emails the tracker can't decide on go to **Review Queue**. Examples: no hiring term and no match, an
ambiguous match, conflicting details, an event after a rejection, or a labeled email it doesn't recognize.
For each row:

1. Open **Source Email Link** and read the email.
2. Set **Decision**:
   - **Approve**: accept the row as it is. If **Candidate Application ID** holds exactly one ID, that
     application is updated. Otherwise a new application is created, which needs a company and a status.
   - **Correct**: same as Approve, after applying **Corrected Values**.
   - **Link**: attach the email to an existing application. Uses the Candidate Application ID, or `app=APP-…`
     in Corrected Values.
   - **Ignore**: drop the email; the tracker won't process it again.
3. **Corrected Values** format, any subset, separated by `;`:
   `company=Acme; role=Software Engineer Intern; term=Summer 2027; status=Interview; reqId=R123; location=Boston, MA; date=2026-10-01; app=APP-abc`
4. Run **Job Tracker → Process review decisions**.

Each processed row gets a **Resolution**. Running it again does nothing: the event is already `COMPLETED` or
`IGNORED`, so even if you clear Resolution it only reports "Already completed". If a value can't be used, the
row's **Review Reason** starts with `ERROR:` and nothing is applied. Fix the value and run it again.
An approved review overrides the contradiction checks, but it **does not** override Manual Status Lock.

### Manual corrections

- Edit **Company / Role / Location / Hiring Term / Requisition ID** directly. Sync only fills blank fields
  and never overwrites what you typed.
- Edit **Current Status** directly. Later emails continue from the value you set.
- Tick **Manual Status Lock** and email events never change that row's status. Dates and deadlines still
  update.
- **Notes** is never written by the script.
- Columns are found by header name, so you can reorder them or add your own columns. Just don't rename the
  built-in headers.

### Missed emails

Create the Gmail label `job-tracker-include` (the `INCLUDE_LABEL` setting) and apply it to any thread the
keyword search missed. If a labeled message isn't recognized as an application email, it goes to review
instead of being skipped. The label only adds messages to the search; the script never adds or removes labels.
Labeling an email that's *older* than the checkpoint has no effect until you run `resetSyncCheckpoint`.

---

## 5. Configuration (Script Properties)

| Key | Default | Meaning |
|---|---|---|
| `ELIGIBLE_TERMS` | `Spring 2027\|Summer 2027` | Terms to track (separated by `\|`). |
| `INITIAL_IMPORT_START` | `2026-01-01` | First day searched. Moving it **earlier** restarts the import automatically. |
| `SEARCH_PHRASES` | confirmations, interviews, assessments, ... | Gmail phrases (`\|`-separated). Broad on purpose; the parser filters. |
| `RECRUITING_SENDERS` | greenhouse.io, lever.co, myworkday.com, ... | Sender domains to always search. |
| `INCLUDE_LABEL` | `job-tracker-include` | Label for manually included threads. |
| `OVERLAP_HOURS` | `48` | How far each window reaches back before the checkpoint. |
| `WINDOW_DAYS` | `14` | Maximum window size during the initial import. |
| `PAGE_SIZE` | `25` | Threads per search; full windows are halved instead of paged. |
| `MAX_RUNTIME_SECONDS` | `270` | Stops starting new windows after about 3.5 minutes (Apps Script's limit is 6). |
| `MAX_MESSAGES_PER_RUN` | `300` | Upper bound on messages per run. |
| `SYNC_INTERVAL_HOURS` | `2` | Must be 1, 2, 4, 6, 8 or 12. Rerun `installTrigger` after changing it. |
| `ALLOW_COMPANY_ONLY_MATCH` | `false` | If `true`, an email naming only the company may update that company's single application. |
| `MY_EMAILS` | (empty) | Extra addresses of yours (`\|`-separated) whose messages are skipped. Your Google account address is skipped automatically. |
| `GMAIL_ACCOUNT_INDEX` | `0` | The `u/0` in email links. Use `1`, `2`, … if this isn't your first signed-in Google account. |

---

## 6. Rules and design choices

**Eligibility.** The hiring term comes from the email's wording, not from the date it was received.
`Summer 2027`, `Summer '27`, `2027 Summer Analyst`, `Summer Internship 2027` and month ranges with a clear
start (`Jan–Apr 2027` → Spring, `May–Aug 2027` → Summer) all count. A bare `2027` never counts.
Mentions near *graduat / class of / degree / enrolled* are ignored, and so is text after footer markers like
*unsubscribe / privacy policy / ©*. If the subject names exactly one term, that term wins. Several different
terms in the body means a conflict, which goes to review.

**What happens to each message:**

| Situation | Result |
|---|---|
| Job ad, job alert or newsletter | SKIP: nothing recorded, never creates an application |
| Out-of-scope term (e.g. Summer 2026), no matching application | IGNORE: recorded in Events for audit |
| Matches an existing application (any or no term) | UPDATE via StatusEngine |
| Eligible term + company + role (or req ID) + clear status, no match | CREATE |
| No term and no match / ambiguous / conflicting / unknown company | REVIEW |

**Matching**, in order:

1. Company + requisition ID.
2. A Gmail thread already linked to an application, if company, term and req ID agree.
3. Company + role, with term and location used to narrow, accepted only when exactly one application fits.

Different roles at the same company are never merged, even when Gmail puts look-alike confirmations in one
thread. The sender's domain is never used as the company. A sender's *display name* is used only when it has a
recruiting suffix, as in "Acme Careers" or "Acme via Greenhouse".

**Statuses:** Applied, Assessment, Interview, Offer, Rejected, Withdrawn. "Needs Review" is not a status; it
means the email is waiting in the Review Queue.

- A confirmation never moves an application backwards; it only fills in **Applied Date**. So an old or
  delayed confirmation can't undo an interview.
- Only confirmations set Applied Date. If the first email you get is an interview invite, Applied Date
  stays blank.
- An event dated before the current status doesn't change the status.
- Reminders and generic updates never change status. They can set **Next Deadline**.
- After Rejected or Withdrawn, a newer conflicting event goes to review. After Offer, anything except
  Withdrawn goes to review.
- Stages aren't assumed to follow a fixed order, so a newer Assessment can follow an Interview.
- **Next Deadline** is set only from explicit text, such as "complete by Oct 8, 2026" or "within 5 business
  days".

**Stable IDs.** IDs come from the Gmail message that created the record: `APP-<messageId>`,
`EVT-<messageId>`, `REV-<messageId>`. Re-processing the same message always produces the same IDs, which is
what keeps crash recovery from creating duplicate applications.

**Checkpoints.** The checkpoint is a single timestamp. Search windows reach `OVERLAP_HOURS` back before it.
When a window returns a full page, it's split in half instead of paged by offset, because new mail reorders
Gmail's results and offset paging could skip threads. The checkpoint moves forward only after a window's
events are all applied.

**Formula safety.** Text columns use the plain-text format, and strings that start with `= + - @` get a
leading apostrophe.

**Adding an LLM later.** Call `EmailParser.registerExtractor(function (email, extraction) { return {...}; })`.
Whatever it returns fills only the fields that are still blank. Matching, status rules and review stay the same.

### Extra columns (beyond the required ones)

- **Applications:** `Status Date` is the date of the event that set the current status, used for ordering.
  `Thread IDs` holds the linked Gmail threads. `Created At` and `Updated At` are timestamps.
- **Events:** `Decision`, `Run ID`, and `Details (JSON)`, which stores the extracted fields so an event can
  be re-applied after a crash. `Updated At`.
- **Review Queue:** `Review ID`, `Event ID`, `Resolution`, `Resolved At`. These make review processing
  idempotent.
- **Sync Log:** `Mode` (SYNC or DRY_RUN) and `Checkpoint`.
- **Dry Run Preview:** a separate tab that each dry run clears and rewrites.

---

## 7. Permissions

These are set explicitly in `src/appsscript.json`:

| Scope | Why |
|---|---|
| `gmail.readonly` | Search and read messages. The script can't change mail. |
| `spreadsheets.currentonly` | Only the spreadsheet this script is bound to. |
| `script.scriptapp` | Create and delete the time-driven trigger. |
| `script.container.ui` | The Job Tracker menu, toasts and alerts. |
| `userinfo.email` | Read your own address so your replies aren't parsed as recruiter emails. |

The script never sends, deletes, archives, labels or marks mail as read. `GmailReader.js` only calls
`search`, `getMessagesForThreads`, and getters such as `getId`, `getDate`, `getPlainBody` and `getLabels`.

**Gmail scope note:** Google's GmailApp reference lists `https://mail.google.com/` (full access) on its
methods. It also says scripts may use "appropriate scopes from the related REST API", and `gmail.readonly` is
the matching read-only scope. I couldn't test this against a real account. If a run fails with an error
saying it needs `https://mail.google.com/`, replace the `gmail.readonly` line in `appsscript.json` with
`https://mail.google.com/`, run `clasp push`, and re-authorize. The code stays read-only either way; only the
permission it asks for gets broader.

---

## 8. Turning automation off

- Spreadsheet: **Job Tracker → Disable automatic sync**, or
- Apps Script editor: run `removeTriggers`, or
- Apps Script editor → **Triggers** (clock icon) → delete the `scheduledSync` trigger.

To revoke access completely, go to <https://myaccount.google.com/permissions>, find **Job Application
Tracker**, and remove access.

---

## 9. Limitations

- **Parsing is heuristic.** Unusual email formats will go to review or be missed. Use the include label, review
  decisions and manual edits. Run a dry run after changing rules.
- **The Google services in the tests are fakes.** Things the local tests can't confirm include: how real Sheets
  handles the apostrophe/plain-text combination, data validation, checkbox behavior, the exact syntax of Gmail
  `after:`/`before:` epoch-second filters, and the `gmail.readonly` question above.
- **Gmail search has limits.** Results are threads, so the tracker reads every message in a matched thread. A
  later message that doesn't match the search and sits in a thread that wasn't matched in that window can be
  missed. The include label is the fallback.
- **Limits and quotas.** Each Apps Script execution can run for at most 6 minutes. Consumer accounts also have
  daily limits on total trigger runtime and Gmail reads. See
  <https://developers.google.com/apps-script/guides/services/quotas> for current values. A long first import
  may need several runs or a day.
- **Not built for concurrent editing.** Rows are found by ID and only changed cells are written, but an edit
  you make in the same second the sync writes that row could still be overwritten.
- **Email links** use `mail.google.com/mail/u/<index>/#all/<messageId>`. Set `GMAIL_ACCOUNT_INDEX` if links
  open the wrong account.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `clasp push`: *User has not enabled the Apps Script API* | Turn the API on at <https://script.google.com/home/usersettings>, wait a minute, then retry. |
| `clasp push` uploads the wrong files | Run `clasp show-file-status`. `.clasp.json` should have `"rootDir": "src"`. |
| Push asks *Manifest file has been updated* | Answer yes; that uploads this project's scopes. |
| *Missing sheet* / *missing column* | Run `setup`. If you renamed a header, change it back. |
| *Exception: ... permission ... https://mail.google.com/* | See the Gmail scope note in [Permissions](#7-permissions). |
| *Cannot call SpreadsheetApp.getUi() from this context* | Harmless when running from the editor; messages go to the execution log instead. |
| Nothing imported | Check `INITIAL_IMPORT_START`, run a dry run, read **Dry Run Preview**. Try the include label on one email. |
| Too many review items | Check the reasons. Common fixes: add the term in Corrected Values, or enable `ALLOW_COMPANY_ONLY_MATCH`. |
| A run stopped halfway | Run `syncNow` again; it recovers PENDING events first. Check **Sync Log → Errors**. |
| Trigger runs twice | Run `installTrigger`. It removes old schedules first. Check **Triggers** in the editor. |
| Want to start over | Delete the data rows in Applications, Events and Review Queue, then run `resetSyncCheckpoint`. |

## 11. Tests

```sh
npm test
```

The tests cover: a 2026 email about a Summer 2027 role, a Spring 2027 co-op, Summer 2026 being ignored,
graduation-year text that must not count as a term, a rejection without a term (matched by role and by
thread), two roles at one company (including Gmail threading them together), a delayed confirmation after an
interview, a newsletter about interviews, interrupted runs (crashing after applications are saved, and while
events are written) with a retry, ambiguous emails going to review, review decisions applied twice, duplicate
prevention across reruns and checkpoint resets, dry-run isolation, the lock, window splitting, formula
safety, preservation of manual edits, and installing the trigger twice.

Keep fixtures synthetic. `.gitignore` excludes `tests/fixtures/real/`, `private/`, `exports/` and common
email/export file types, so real email content doesn't get committed.
