# notion-feeder Refactor — Implementation Plan

> **For agentic workers:** implement task-by-task, in order. Steps use checkbox (`- [ ]`)
> syntax for tracking. Every task ends with a commit and a real verification — do not batch
> tasks, and do not mark a box until its Verify block has actually been run and matched.

**Goal:** Fix a silent duplicate-detection failure, remove 31% of the run time, and put a
test harness under a codebase that currently has none — without changing what lands in the
Notion reader database.

**Findings and evidence:** [`../REFACTORING.md`](../REFACTORING.md). That document is the
*why*; this one is the *how*. Read it first — several tasks below only make sense against
the measurements in it.

**Tech stack:** Node 22 (ESM), webpack 5 + babel, `rss-parser`, `@notionhq/client`,
`@tryfabric/martian`, deployed as a rootless Podman Quadlet oneshot on the homelab services
VM via `ansible/notion-feeder.yml` in the `homelab` repo.

---

## Environment — read before Task 1

**There is no `node`, `npm`, or `npx` on the dev VM.** Podman is available. Every Node
command in this plan therefore runs in a throwaway container:

```sh
cd ~/workspace/github/notion-feeder
podman run --rm -v "$PWD":/app:z -w /app node:22-alpine sh -c '<command>'
```

`node_modules/` created this way is gitignored and safe to leave behind. It is owned by
root; if a later step needs to remove it, do so inside a container.

| Thing | Value |
|---|---|
| Repo | `/home/mike/workspace/github/notion-feeder`, branch `master`, remote `origin` |
| Deploy | `cd /home/mike/workspace/github/homelab/ansible && ansible-playbook -i inventory.ini notion-feeder.yml` |
| Run on VM | `ansible services -i inventory.ini -m shell -a 'systemctl --user start notion-feeder.service'` |
| Read logs | `ansible services -i inventory.ini -m shell -a 'journalctl --user -u notion-feeder --since "-10min" --no-pager -o cat'` |
| Reader DB | `7ab6387a38154ac18db8728ecc2f9e44` |
| Feeds DB | `1b17c77ea6db4e4da6218d5b71ef4f2c` |
| Notion token | `~/.secrets`, line `export NOTION_API_TOKEN=…` |

### Baseline to measure against (2026-08-01 23:52:25 → 23:54:42 UTC)

```
137 s total, 56 enabled feeds
 42 s  getExistingArticles()  -> "Found 10000 existing articles in Reader"
 95 s  fetching 56 feeds sequentially
```

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Never print a secret value.** To use the Notion token:
  `export $(grep -m1 '^export NOTION_API_TOKEN=' ~/.secrets | sed 's/^export //')`.
  Never `echo` it, never paste it into a file, never include it in a commit or log line.
- **`npm run build-prod` must pass at every commit.** It runs eslint via
  `eslint-webpack-plugin`, so a lint error fails the build. Warnings are fine — there are
  3 pre-existing `Critical dependency` warnings from `jsdom`/`got`/`request`.
- **Verify by observed outcome, not by exit code.** An `ok`/`changed`/exit-0 from Ansible,
  npm, or systemd means the command ran, not that the result is right. On 2026-08-01 the
  deploy playbook reported `changed=3` while the container image was still missing. Always
  check the actual artifact or the actual log.
- **Never mutate the Notion reader database. No exceptions.** Reads are fine; archiving,
  deleting, or bulk-updating reader rows is not — in any task, for any reason, including
  "cleaning up" the 10,000+ row backlog. The owner decided on 2026-08-02 to leave it in
  place (Task 8). The only Notion *writes* this plan authorises are: new article pages
  created by the normal sync, and the two new feed-health properties in Task 7.
- **One task, one commit.** `refactor(...)` for behaviour-preserving, `fix(...)` for
  behaviour change, `test(...)` for test-only, `chore(...)` for deps/build.
- **Push after every commit:** `git push origin master`.
- **Deploy only where a task says to.** Tasks 1, 2, 10 are build/test-only and do not need
  a deploy; 3–7 and 9 do.
- **If a Verify block does not match, stop and report.** Do not proceed to the next task,
  and do not "fix forward" past a failed verification.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `package.json` | Modify (T1, T2) | Drop 4 unused deps; add `"type": "module"` and a `test` script |
| `webpack.config.js` → `.cjs` | Rename (T2) | Uses `module.exports`; breaks under `"type": "module"` |
| `.eslintrc.js` → `.cjs` | Rename (T2) | Same reason |
| `.prettierrc.js` → `.cjs` | Rename (T2) | Same reason |
| `test/xml.test.js` | Create (T2) | Pins for `src/xml.js` |
| `test/helpers.test.js` | Create (T2) | Pins for `src/helpers.js` |
| `test/dedup.test.js` | Create (T4) | Pins for the extracted dedup |
| `src/notion.js` | Modify (T3, T8, T10) | Date-bounded reader query; constants |
| `src/feed.js` | Modify (T4, T5, T6, T10) | Dedup, timeout, concurrency, dead loop |
| `src/index.js` | Modify (T9) | Readability replacement |
| `homelab:containers/notion-feeder/notion-feeder.container` | Modify (T11) | `LogDriver=passthrough` |

---

## Task 1 — Remove unused dependencies

`chore(deps): drop four unused packages`

**Why:** `http@0.0.1-security` is a name-squatting placeholder, not a module. `async`,
`icecream`, and `node-icecream` are declared and never imported. Verified with
`grep -rho "from '<dep>'\|require('<dep>')" src/` → 0 hits for each.

- [ ] Remove `async`, `http`, `icecream`, `node-icecream` from `dependencies` in
      `package.json`. Leave every other dependency alone.
- [ ] Regenerate the lockfile:
      `podman run --rm -v "$PWD":/app:z -w /app node:22-alpine sh -c 'npm install --no-fund --no-audit'`
- [ ] Build: `podman run --rm -v "$PWD":/app:z -w /app node:22-alpine sh -c 'npm run build-prod 2>&1 | tail -5'`

**Verify**
- Build ends with `webpack 5.64.4 compiled with 3 warnings` (3, not more — a new warning
  means something real changed).
- `git diff --stat package.json` shows exactly 4 removed lines.
- `grep -rn "require('async')\|from 'async'" src/` → no output.

**Rollback:** `git revert`. No runtime state involved; nothing deployed.

---

## Task 2 — Test harness

`test: add node:test harness and pin the pure modules`

**Why:** there are no tests. Every later task changes behaviour, and none of them can be
made safe without this. Node 22 ships `node:test` — no new dependency.

**The hazards.** `"type": "module"` makes Node treat every `.js` file as ESM, which breaks
three separate things. **This whole task was rehearsed end-to-end on a scratch copy on
2026-08-02; the four steps below are the version that passes both gates.** Do them all in
one commit — the intermediate states do not build.

1. `webpack.config.js`, `.eslintrc.js`, `.prettierrc.js` use `module.exports` →
   `ReferenceError: module is not defined`. Rename all three to `.cjs`.
   (`.babelrc` is JSON and needs no change. Webpack 5 auto-discovers `webpack.config.cjs`,
   and the `build-prod`/`develop` scripts do not pass `--config`, so they need no edit —
   verified.)
   **Also update `dockerfile`** — it `COPY`s `webpack.config.js` by explicit name, so the
   image build fails with a missing-file error the moment this file is renamed.
   **Also update `homelab/ansible/notion-feeder.yml`** — its `Copy build context` task
   lists `webpack.config.js` in a loop of files to ship to the VM. Neither of these was
   caught by the local `npm run build-prod` check during the 2026-08-02 rehearsal; both
   only surfaced when actually deploying (Task 3). Grep both repos for the literal string
   `webpack.config.js` and fix every hit in the same commit as the rename.
2. **ESM requires fully specified import paths.** `src/` has six extensionless relative
   imports; under `"type": "module"` webpack fails with
   `BREAKING CHANGE: The request './parser' failed to resolve only because it was resolved
   as fully specified` — **3 errors, build fails**. Every one needs a `.js` suffix.
3. **`node --test test/` does not work on Node 22** — it resolves `test` as a module and
   dies with `Cannot find module '/app/test'`, reporting `pass 0 fail 1`. Use bare
   `node --test`, which auto-discovers `test/*.test.js` (verified: `pass 3 fail 0`).
   `node --test test/*.test.js` also works if you prefer it explicit.

- [ ] `git mv webpack.config.js webpack.config.cjs`
- [ ] `git mv .eslintrc.js .eslintrc.cjs`
- [ ] `git mv .prettierrc.js .prettierrc.cjs`
- [ ] Add `.js` to all six extensionless relative imports:
      ```
      src/index.js:4  './feed'    -> './feed.js'
      src/index.js:5  './notion'  -> './notion.js'
      src/index.js:6  './parser'  -> './parser.js'
      src/feed.js:4   './helpers' -> './helpers.js'
      src/feed.js:5   './notion'  -> './notion.js'
      src/feed.js:6   './xml'     -> './xml.js'
      ```
      One command does it, but re-read the diff afterwards:
      `sed -i -E "s#(from '\./[a-zA-Z]+)'#\1.js'#g" src/*.js`
      Then confirm none remain: `grep -rnE "from '\./[^']*'" src/ | grep -v "\.js'"`
      must print nothing.
- [ ] In `package.json`: add `"type": "module"` at top level, and add
      **`"test": "node --test"`** to `scripts`.
- [ ] Create `test/xml.test.js` pinning `src/xml.js`. Required cases, all of which were
      run ad-hoc on 2026-08-01 and passed:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeBareAmpersands, looksLikeHtml } from '../src/xml.js';

test('escapeBareAmpersands leaves valid entities untouched', () => {
  for (const s of ['a &amp; b', '&lt;x&gt;', 'it&#8217;s', 'it&#x2019;s',
                   'a&nbsp;b', '&foo.bar-baz;']) {
    assert.equal(escapeBareAmpersands(s), s);
  }
});

test('escapeBareAmpersands repairs real-world bare ampersands', () => {
  assert.equal(escapeBareAmpersands('analyses, & other'), 'analyses, &amp; other');
  assert.equal(escapeBareAmpersands('?a=1&display=swap'), '?a=1&amp;display=swap');
  assert.equal(escapeBareAmpersands('x&&y'), 'x&amp;&amp;y');
  assert.equal(escapeBareAmpersands('ends with &'), 'ends with &amp;');
});

test('escapeBareAmpersands is idempotent', () => {
  assert.equal(escapeBareAmpersands(escapeBareAmpersands('a & b')), 'a &amp; b');
});

test('looksLikeHtml detects HTML by content-type and by body', () => {
  assert.equal(looksLikeHtml('text/html; charset=utf-8', '<rss>'), true);
  assert.equal(looksLikeHtml('', '<!DOCTYPE html>\n<html>'), true);
  assert.equal(looksLikeHtml(undefined, '  <html lang="en">'), true);
});

test('looksLikeHtml does not misclassify feeds', () => {
  assert.equal(looksLikeHtml('application/rss+xml', '<?xml version="1.0"?><rss>'), false);
  assert.equal(looksLikeHtml('application/atom+xml', '<feed xmlns="x">'), false);
  assert.equal(looksLikeHtml('application/xml', '<?xml?><rss><title>html tips</title>'), false);
  assert.equal(looksLikeHtml('', ''), false);
});
```

- [ ] Create `test/helpers.test.js` pinning `timeDifference` from `src/helpers.js` —
      at minimum: exact-day boundaries, sub-day differences, and a negative difference
      (`date2` in the future), since `getNewFeedArticlesFrom` compares `diffInDays <= N`
      and a future `pubDate` must not be silently excluded.
- [ ] Run: `podman run --rm -v "$PWD":/app:z -w /app node:22-alpine sh -c 'npm test'`
- [ ] Run: `podman run --rm -v "$PWD":/app:z -w /app node:22-alpine sh -c 'npm run build-prod 2>&1 | tail -5'`

**Verify** — both gates, exactly as rehearsed on 2026-08-02:
- `npm test` → `# fail 0`, with `# pass` matching your test count.
- `npm run build-prod` → ends `webpack 5.64.4 compiled with 3 warnings`. **This is the real
  gate.** `compiled with 3 errors and 3 warnings` means step 2 above was missed. A broken
  build here ships nothing, and the deploy playbook will still report `changed`.

**Rollback:** `git revert`. Nothing deployed.

---

## Task 3 — Bound the reader-database query by date

`fix(notion): bound the existing-articles query to the backfill window`

**Why (finding #1, #2):** `getExistingArticles()` pages the reader DB unfiltered and stops
at exactly 10,000 rows reporting `has_more: false` on a *perfectly full* 100th page. A
`Created At <= now-30d` filter also returns exactly 10,000 while `>= now-14d` returns 434 —
mutually impossible unless 10,000 is a pagination ceiling. So dedup silently believes it has
the whole list. It also costs 42 s and 100 round-trips per run, growing.

Only articles inside the backfill window can be inserted, so only those need to be in the
dedup set. Filtering fixes the correctness bug and the cost together.

Verified 2026-08-02 against the live reader DB: the property is named exactly
`Created At` and its type is **`created_time`**. A `date` filter works on it, and it
accepts a full ISO-8601 timestamp with timezone (`.toISOString()`) — a 14-day filter
returned in 0.6 s. No schema change is needed for this task.

- [ ] Change `getExistingArticles()` in `src/notion.js` to accept `sinceDays` and add a
      Notion filter on the `Created At` property:

```js
export async function getExistingArticles(sinceDays) {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);
  // ... existing pagination loop, but pass:
  //   filter: { property: 'Created At', date: { on_or_after: since.toISOString() } }
}
```

- [ ] In `src/feed.js`, call it with the backfill window plus a margin:
      `const windowDays = Number(NOTION_FEEDER_BACKFILL_DAYS || 7) + 7;`
      The margin covers clock skew and articles whose `pubDate` trails their insertion date.
- [ ] Change the existing log line to include the window and the elapsed time, e.g.
      `Found ${articles.length} existing articles in Reader (last ${windowDays}d, ${ms}ms)`.
      The current line is the only visibility into this phase; keep it informative.
- [ ] Build, deploy, run.

**Verify** — all four, in order:
1. Log shows roughly `Found ~450 existing articles in Reader (last 14d, ~2500ms)`, not
   `Found 10000`. Expect ≈450 rows and ≈2.5 s against the 2026-08-01 baseline of 10,000 and
   42 s.
2. Total run time drops by ~40 s from the 137 s baseline.
3. **No duplicates.** Run the service twice back-to-back. The second run must report
   `Run complete: 0 item(s) processed`. If it processes anything the first run already
   added, the window is too narrow — stop and report rather than widening blindly.
4. Reader row count is unchanged apart from genuinely new articles.

**Rollback:** `git revert`, redeploy. This task only reads from Notion, so there is no data
to restore.

**Risk:** an article republished with a fresh `pubDate` after its reader row aged out of the
window would be re-added. Accepted — arguably the correct behaviour.

---

## Task 4 — Set-based dedup

`refactor(feed): dedup existing articles through a Set`

**Why (finding #5):** dedup is a linear `.find()` over the existing-articles array, per new
item. After Task 3 the array is small, so this is no longer a performance fix — it is a
clarity fix and a place to hang a test.

- [ ] Extract the dedup into an exported pure function in `src/feed.js`, e.g.
      `export function dedupeAgainst(existingUrls, articles)` taking a `Set` of URLs.
- [ ] Build the `Set` once from `getExistingArticles()`; keep the existing behaviour of
      adding each accepted article's URL to the set as it is accepted, so duplicates
      *within a single run* are still caught.
- [ ] Keep the `Remove duplicated article: <title>` log line — it is the only signal that
      dedup is working at all.
- [ ] Add `test/dedup.test.js`: an article already present is dropped; a new one is kept;
      two identical articles in the same batch yield one; an article with no `link` does not
      throw.

**Verify**
- `npm test` green, including the new file.
- Deploy, run twice; second run reports `Run complete: 0 item(s) processed`.

**Rollback:** `git revert`, redeploy.

---

## Task 5 — Configurable, shorter feed timeout

`fix(feed): make the per-feed timeout configurable and default it to 20s`

**Why (finding #7):** the timeout is a hard-coded 60 s. On 2026-08-01 one slow host
(`kill-the-newsletter.com`) spent 60 s of a 137 s run doing nothing.

Verified 2026-08-02: `new Parser({ timeout: N })` is accepted, and rss-parser's default
is `60000` — which confirms where the 60 s came from.

- [ ] Add `NOTION_FEEDER_FEED_TIMEOUT_MS`, default `20000`. Apply it to both the
      `rss-parser` construction (`new Parser({ timeout })`) and the `got.get` refetch inside
      `parseFeed` — they are currently inconsistent and both must honour it.
- [ ] Add the variable to the rendered env file in the homelab repo:
      `ansible/notion-feeder.yml`, alongside `NOTION_FEEDER_BACKFILL_DAYS`. Also add a
      matching `notion_feeder_feed_timeout_ms` var with the same default, so the value is
      declared in one place.

**Verify**
- Point a scratch feed row at `http://127.0.0.1:1/rss` (a closed port), run, and confirm the
  failure appears in ~20 s rather than ~60 s. **Disable that scratch row afterwards.**
- A normal run still fetches all healthy feeds — compare the count of `Fetching from` lines
  to the enabled-feed count.

**Rollback:** `git revert` in both repos, redeploy.

---

## Task 6 — Fetch feeds concurrently

`perf(feed): fetch feeds with bounded concurrency`

**Why (finding #7):** 56 feeds are fetched strictly sequentially, 95 s of the run.

- [ ] Replace the sequential `for` loop in `getNewFeedItems()` with a bounded-concurrency
      pool, limit 6. **Do not add a dependency** — `async` was removed in Task 1 and a small
      promise pool is ~15 lines. Do not use `Promise.all` unbounded: 56 simultaneous fetches
      against unrelated hosts is impolite and will trip rate limits.
- [ ] Preserve the existing per-feed `try/catch` so one failing feed still cannot abort the
      run, and keep the `Error fetching <url> <err>` line shape — Task 7 and the operator
      runbook both depend on it.
- [ ] The final `newArticles.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate))`
      already makes ordering independent of fetch order. Confirm it is still applied *after*
      the pool resolves.

**Verify** — the equivalence check matters more than the speed-up:
1. Before deploying, capture the sorted article URLs from a sequential run.
2. After deploying, capture them from a concurrent run over the same feed list.
3. The two sets must be identical. A different set means concurrency changed behaviour —
   stop and report.
4. Feed phase drops from ~95 s to roughly 20–30 s.

**Rollback:** `git revert`, redeploy.

---

## Task 7 — Write feed health back to Notion

`feat(notion): record feed fetch failures on the feed row`

**Why (finding #8):** five feeds were dead, two long enough for the publisher to have
rebuilt their site, and the only way to find them was reading four days of logs by hand. The
run still exits 0.

**Do not reuse the existing properties.** Both candidates were inspected on 2026-08-02 and
both are human-owned:

| Property | Type | Actual use | Verdict |
|---|---|---|---|
| `Parse quality` | `select` — options `Excellent`, `poor` | 3 of 65 rows set; an editorial judgement about *content* quality | Reusing it would conflate content quality with fetch health and overwrite a human rating |
| `Notes` | `rich_text` | 7 of 65 rows, hand-written prose | Machine writes would clobber human notes |

This task therefore **adds two properties** to the feeds database. That is a deliberate
reversal of the "no schema changes" non-goal, made because the alternative destroys
information a person put there.

**Unverified — check this first.** The integration is a workspace-owned bot, but whether
it may edit a *database schema* (as opposed to page properties) was deliberately not
tested, since doing so means mutating the schema. Try the PATCH; if it returns 403 or
`validation_error`, stop and report — the fallback is for the owner to add the two
properties by hand in the Notion UI, after which the rest of this task works unchanged.

- [ ] Add to the feeds DB (`1b17c77ea6db4e4da6218d5b71ef4f2c`) via
      `PATCH /v1/databases/{id}`:
      - `Fetch status` — `select`, options `OK` and `Failing`.
      - `Last fetch error` — `rich_text`.
      Adding a property is non-destructive and affects no existing row.
- [ ] On fetch failure: set `Fetch status = Failing` and write
      `<ISO-8601 UTC>: <first line of error>` to `Last fetch error`, truncated to 200
      characters (stack traces are long and Notion rich-text has limits).
- [ ] On success: set `Fetch status = OK` and clear `Last fetch error`.
- [ ] Never touch `Parse quality` or `Notes`.
- [ ] Failures writing these must **never** fail the run — wrap in their own `try/catch`,
      log at most one line.
- [ ] `getFeedUrlsFromNotion()` must also return each feed's `id`, so the writeback knows
      which page to patch.
- [ ] Do **not** auto-disable feeds in this task. That needs a consecutive-failure counter
      that cannot fire on a transient error, and it is a separate decision.

**Verify**
- `Parse quality` and `Notes` are byte-identical before and after a full run. Capture both
  columns for all 65 rows before the run and diff after. **This is the important check** —
  it is the one that proves human data was not touched.
- Add a scratch feed row pointing at `http://127.0.0.1:1/rss`, run, confirm
  `Fetch status = Failing` and a plausible timestamp in `Last fetch error`.
- Repoint that row at a known-good feed, run, confirm it flips to `OK` and the error clears.
- **Delete or disable the scratch row when done.**

**Rollback:** `git revert`, redeploy. Leave the two new properties in place — they are inert
once nothing writes them, and deleting a Notion property deletes its data irreversibly.

---

## Task 8 — DECLINED: do not enable the retention cleanup

**Decision, 2026-08-02, by the repo owner: leave the 10,000+ rows alone. Do not implement
this task. Do not archive, delete, or bulk-update reader rows for any reason.**

`deleteOldUnreadFeedItemsFromNotion()` in `src/notion.js` stays defined and uncalled. Leave
it that way. Do not "tidy" it by wiring it up, and do not delete it as dead code — it is
retained deliberately, and this section is the record of why.

Had it been enabled, it would have archived every unread reader row older than 30 days — at
least 10,000 — in one pass. Recoverable from Notion trash for 30 days, but a large mutation
of real data that nobody asked for.

**This does not block anything.** Task 3 bounds the *query* by date rather than bounding the
*database* by deletion, which is why it was designed that way: the reader DB can hold a
million rows and the sync still reads only the last two weeks. Task 3 is the fix; retention
was never a prerequisite for it.

What remains true while the backlog stays:

- The 10,000-row pagination ceiling is still there. It no longer affects dedup after Task 3,
  but **any new unbounded `databases.query` against the reader DB will silently truncate at
  10,000 and report `has_more: false`**. Treat that as a standing trap, not a solved problem.
- The true row count stays unknown — the ceiling makes it unmeasurable by pagination.
- Notion's own UI will keep getting slower on that database. That is the owner's call, not
  this codebase's.

If the decision is ever revisited, the two things to settle first are whether 30-day unread
retention is wanted at all, and that the function's query is **unpaginated** — it sees only
the first 100 matches, so leaving it that way drains 100 rows per run, which at this backlog
is a far gentler rollout than paginating it.

---

## Task 9 — Replace `node-readability`

`chore(deps): replace node-readability with @mozilla/readability`

**Why (finding #10):** unmaintained, pulls `jsdom` and the deprecated `request`, and is the
source of all 3 webpack warnings. It is also why `src/index.js` needs an explicit
`process.exit()` — jsdom and `got` leave handles open and the event loop never drains.

- [ ] Replace with `@mozilla/readability` + `linkedom` (lighter) or `jsdom` (higher
      fidelity). Keep `getItemContent()`'s existing "pick the longest of readable content /
      `content:encoded` / `content` / placeholder" behaviour exactly.
- [ ] **Content-quality check before committing.** Take 20 recent article URLs from the
      reader DB, extract with both the old and the new implementation, and compare output
      lengths. The new one must never return empty where the old one succeeded. Record the
      comparison in the commit message.
- [ ] Only after that: check whether the process now exits on its own without the explicit
      `process.exit()`. **Remove the hack only with evidence** — a regression there hangs the
      systemd oneshot until `TimeoutStartSec=1800`, i.e. a 30-minute stuck unit every night.
      If in doubt, leave it.

**Verify**
- `npm run build-prod` → fewer than 3 warnings (the `request` and `jsdom` ones should be
  gone).
- Deploy, run, confirm `Result=success` and that articles still land with real body content,
  not `page not captured due to error`.

**Rollback:** `git revert`, redeploy.

---

## Task 10 — Small cleanups

`refactor: split the overloaded block-limit constant; drop a dead loop`

- [ ] **Finding #9:** `MAX_PARAGRAPH_LENGTH = 95` is used for two unrelated Notion limits —
      rich-text runs per paragraph (`src/notion.js` ~line 173) and child blocks per request
      (~line 233). Both API limits are 100. Replace with `MAX_RICH_TEXT_RUNS_PER_BLOCK` and
      `MAX_BLOCKS_PER_REQUEST`, both `95`, and comment that 95 is a deliberate margin under
      the API's 100.
- [ ] **Finding #12:** delete the dead loop in `src/feed.js`:

```js
for (let i = 0; i < items.length; i++) {
  items[0].feed = feed;   // assigns index 0 every iteration; value never read
}
```

      `matchFeedFilter(feed, item)` takes `feed` as its own argument and never reads
      `item.feed`. Confirm that with a grep before deleting, and add a test asserting
      filtering still works with the property absent.

**Verify:** `npm test` green; `npm run build-prod` green; deploy and confirm a run still
produces articles with the same block structure (spot-check one long article in Notion for
correct paragraph splitting).

---

## Task 11 — Stop the duplicate journald logging (homelab repo)

`fix(notion-feeder): stop double-logging to journald`

**Why (finding #11):** every log line is written twice, by `conmon` and by `podman` —
verified with `journalctl -o json` grouped by `_COMM`: 1035 identical lines from each. It is
a logging artifact, **not** a double run; nothing is written to Notion twice. But it doubles
journald volume and it reads like the sync is running twice, which is actively misleading.

- [ ] In `homelab`, add `LogDriver=passthrough` to the `[Container]` section of
      `containers/notion-feeder/notion-feeder.container`.
- [ ] Deploy with `ansible-playbook -i inventory.ini notion-feeder.yml`.

**Verify**

```sh
ansible services -i inventory.ini -m shell -a \
  'journalctl --user -u notion-feeder --since "-10min" --no-pager -o json |
   python3 -c "import sys,json,collections; c=collections.Counter();
   [c.update([json.loads(l).get(\"_COMM\")]) for l in sys.stdin]; print(c)"'
```

One writer, and the line count roughly halves. Logs must still be readable via
`journalctl --user -u notion-feeder` — if `passthrough` sends output somewhere else on this
podman version, revert rather than losing the logs.

**Rollback:** `git revert` in `homelab`, redeploy.

---

## Non-goals

- **Removing webpack.** Measured and rejected: the runtime image is 173 MB holding a single
  5.7 MB bundle and **no `node_modules`**. Dropping the bundler would ship dependencies
  instead.
- **TypeScript.** Not justified at 670 lines; Task 2 buys most of the same confidence.
- **Repurposing existing Notion properties.** `Parse quality` and `Notes` are human-owned
  (verified 2026-08-02: 3 and 7 rows in use respectively). Task 7 adds two new properties
  rather than overwriting either. Adding is non-destructive; reusing would not be.
- **Feed curation.** Which feeds to keep is a content decision, not a refactor.

---

## Open questions for the repo owner

1. **Task 8 retention** — is 30-day unread retention wanted at all? Blocks Task 8 entirely.
2. **The 10,000 ceiling** — is it Notion's API limit or something about this integration?
   The evidence is strong but circumstantial. Task 3 makes it moot rather than answering it;
   worth confirming before relying on any other unbounded `databases.query`.
3. **True reader-DB size** — unknown and unknowable through the paginated query. A filtered
   count per month would establish it.
