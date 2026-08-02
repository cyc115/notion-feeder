# notion-feeder refactoring spec

Written 2026-08-02, from measurements against the live deployment on the homelab
services VM. Every finding below carries the evidence that produced it, so each can be
re-checked rather than taken on trust.

The steps are ordered so that **each one ships and is verified on its own**. None depends
on a later step. Stop after any of them and the service is in a working, better state.

---

## How these findings were established

| Method | What it produced |
|---|---|
| `journalctl --user -u notion-feeder -o short-iso` on the services VM, one full run | wall-clock phase timings |
| Direct Notion API pagination against the reader DB (`7ab6387a…`) | row counts, round-trip counts, the pagination ceiling |
| `grep` for each declared dependency across `src/` | unused dependencies |
| `podman run --entrypoint sh localhost/notion-feeder:local` | runtime image composition |
| `journalctl -o json`, grouped by `_COMM`/`_PID` | the duplicate-log cause |
| `node:22-alpine` container running the modules directly | unit-level behaviour of new code |

Baseline run, 2026-08-01 23:52:25 → 23:54:42 UTC — **137 s total**, 56 enabled feeds:

```
23:52:25  service start
23:53:07  "Found 10000 existing articles in Reader"   <- 42 s, 31% of the run, before any feed
23:54:42  finished
```

---

## Findings

| # | Finding | Evidence | Severity |
|---|---|---|---|
| 1 | **Dedup is silently truncated.** `getExistingArticles()` pages the reader DB unfiltered and stops at exactly 10,000 rows with `has_more: false` | 100 pages × 100 rows; a `Created At <= now-30d` filter *also* returns exactly 10,000, while `>= now-14d` returns 434 — mutually inconsistent unless 10,000 is a ceiling | **High — correctness** |
| 2 | That scan costs **42 s and 100 API round-trips on every run**, before a single feed is fetched, and grows with the DB | timings above; filtered to 14 days the same query is **434 rows, 5 round-trips, 2.4 s** | **High** |
| 3 | **`deleteOldUnreadFeedItemsFromNotion()` is never called.** The reader DB has no bound at all | `grep -rn deleteOldUnreadFeedItemsFromNotion src/` → one hit, its own definition | **High** |
| 4 | **No tests exist.** No `test` script, no test directory, no framework | `package.json` scripts: `develop`, `feed`, `build-prod`, `container-build` | **High — blocks safe change** |
| 5 | Dedup is O(N×M): a linear `.find()` over the existing-articles array, per new item | `src/feed.js` `newArticles.filter(... existingArticles.find(...))` | Medium |
| 6 | **Four unused dependencies**, including `http@0.0.1-security` — a placeholder package squatting the name, not a real module | `grep` for each dep in `src/`: `async`, `http`, `icecream`, `node-icecream` all unreferenced | Medium — supply chain |
| 7 | Feeds are fetched **strictly sequentially** with a 60 s timeout each. One hung host stalls the whole run | 56 feeds in 95 s; `kill-the-newsletter` alone contributed a 60 s timeout on 2026-08-01 | Medium |
| 8 | **Dead feeds are invisible.** A feed can 404 for months and nothing surfaces it; the run still exits 0 | 5 dead feeds found only by reading logs by hand. The feeds DB already has an unused `Parse quality` property | Medium |
| 9 | `MAX_PARAGRAPH_LENGTH = 95` is used for **two unrelated Notion limits** — rich-text runs per paragraph (limit 100) and child blocks per request (limit 100) | `src/notion.js` line 173 vs. 233 | Low |
| 10 | `node-readability` is unmaintained: pulls `jsdom` and the deprecated `request`. It is the reason `index.js` needs an explicit `process.exit()` to terminate | 3 webpack `Critical dependency` warnings; the comment in `src/index.js` | Medium |
| 11 | Every log line is **written to journald twice**, by `conmon` and by `podman` | `journalctl -o json` grouped by `_COMM`: 1035 lines each, identical | Low — ops, not code |
| 12 | `for (i…) { items[0].feed = feed }` assigns index 0 every iteration; the value is never read anyway | `src/feed.js` | Low — dead code |

**Not a finding:** the duplicate log lines are a journald artifact (#11), **not** a double run. Nothing is written to Notion twice.

**Keep webpack.** It looked like a candidate for removal, but the runtime image is 173 MB containing a single 5.7 MB bundle and **no `node_modules`**. Dropping the bundler would mean shipping dependencies instead. It stays.

---

## Plan

### Phase 1 — Make change safe (no behaviour change)

#### Step 1.1 — Remove unused dependencies
- **Change:** drop `async`, `http`, `icecream`, `node-icecream` from `package.json`; regenerate the lockfile.
- **Why first:** `http@0.0.1-security` is a name-squatting placeholder. Removing four unused packages shrinks the dependency surface before anything else touches the tree.
- **Verify:** `npm run build-prod` succeeds; built bundle byte-size does not grow; container run produces an identical log shape.
- **Rollback:** revert the commit; no runtime state involved.

#### Step 1.2 — Add a test harness
- **Change:** add `"type": "module"` to `package.json`, rename `webpack.config.js` → `webpack.config.cjs`, add `"test": "node --test test/"`. Use Node 22's built-in `node:test` — no new dependency.
- **First tests:** the two pure modules that already exist and have no I/O — `src/xml.js` (`escapeBareAmpersands`, `looksLikeHtml`) and `src/helpers.js` (`timeDifference`). The 19 assertions already written ad-hoc during the 2026-08-01 parser fix become the seed suite.
- **Verify:** `npm test` green; `npm run build-prod` still green (this is the risky half — the ESM switch can break the babel/webpack path).
- **Rollback:** revert; nothing deployed.
- **Note:** this step exists to make Phase 2 safe. Do not skip it.

### Phase 2 — Fix the reader-database problem (the big win)

Findings #1, #2, #3, #5. Ship these three steps together only if you want; they are separable.

#### Step 2.1 — Bound the existing-articles query by date
- **Change:** `getExistingArticles()` takes a `sinceDays` argument and filters on `Created At >= now - sinceDays`. Call it with `NOTION_FEEDER_BACKFILL_DAYS + 7` (a margin for clock skew and late-arriving pubDates).
- **Rationale:** only articles inside the backfill window can ever be candidates for insertion, so only those need to be in the dedup set. This fixes #1 and #2 at once — the ceiling stops mattering because the filtered result is far below it.
- **Verify:** log the row count and elapsed time before and after. Expect ~10,000/42 s → ~450/2.5 s. Then confirm **no duplicates are created**: run twice in a row and assert the second run reports 0 items processed.
- **Rollback:** revert; the reader DB is unmodified by this change.
- **Risk:** an article republished with a fresh `pubDate` after its reader row aged out of the window would be re-added. Acceptable — arguably correct behaviour.

#### Step 2.2 — Use a Set for dedup
- **Change:** build a `Set` of existing URLs once; replace the per-item `.find()`.
- **Verify:** covered by the Step 2.1 double-run assertion; add a unit test now that Phase 1 makes that possible.
- **Rollback:** revert.

#### Step 2.3 — Actually call the retention cleanup
- **Change:** call `deleteOldUnreadFeedItemsFromNotion()` from `index()` after the sync completes.
- **Do this deliberately, not blindly.** It archives every unread row older than 30 days, and the current backlog is **at least 10,000 rows** — one run would archive all of them. Notion archive is recoverable (trash, 30 days), but this is still a bulk mutation of real data. Confirm the retention policy is wanted before enabling, and consider a first run with an explicit cap.
- **Also fix:** its query is unpaginated, so it only ever sees the first 100 matches. Paginate it, or accept that it drains 100 per run — which, at 10,000+ backlog, is a gentler rollout and may be preferable.
- **Verify:** count rows before and after; confirm the count drops by exactly the number archived and that no *read* rows were touched.
- **Rollback:** Notion trash restore, within 30 days.

### Phase 3 — Resilience and visibility

#### Step 3.1 — Make the feed timeout configurable and shorter
- **Change:** `NOTION_FEEDER_FEED_TIMEOUT_MS`, default 20000 (currently a hard 60 s).
- **Verify:** a deliberately slow feed fails in ~20 s; total run time drops when a straggler is present.

#### Step 3.2 — Fetch feeds concurrently
- **Change:** replace the sequential `for` loop with a bounded-concurrency map (limit 6–8). Do **not** use the `async` package — it was removed in Step 1.1; a small `Promise` pool is enough.
- **Verify:** same set of articles produced as a sequential run over the same feed list (compare sorted URLs); wall clock for the feed phase drops from ~95 s to ~20 s.
- **Risk:** ordering. The code sorts by `pubDate` afterwards, so concurrency must not change the final set — assert that explicitly.

#### Step 3.3 — Write feed health back to Notion
- **Change:** on fetch failure, write the reason and a UTC timestamp to the feed row's existing `Parse quality` property. On success, clear it.
- **Why:** finding #8. Five feeds were dead — two for long enough that the publisher had rebuilt their site — and the only way to discover this was reading four days of logs by hand. The schema already has the field.
- **Verify:** disable a feed's host (or point a test row at `http://127.0.0.1:1/rss`), run, confirm the property is populated; restore, run, confirm it clears.
- **Consider:** a consecutive-failure counter, auto-unchecking `Enabled` after N runs. Design it so it can never disable a feed on a transient error.

### Phase 4 — Dependency modernization

#### Step 4.1 — Replace `node-readability`
- **Change:** swap for `@mozilla/readability` + `linkedom` (or keep `jsdom` if fidelity matters). This removes the deprecated `request` transitive dependency and all three webpack warnings.
- **Verify:** extract content from ~20 recent article URLs with both implementations and diff the output lengths; the new one should be within a reasonable band and never empty where the old one succeeded.
- **Bonus:** the explicit `process.exit()` hack in `index.js` exists because jsdom and `got` leave handles open. Once this lands, check whether the process now drains on its own — and if so, remove the hack **only with evidence**, since a regression there hangs the systemd unit until `TimeoutStartSec=1800`.

#### Step 4.2 — Split the overloaded constant
- **Change:** replace `MAX_PARAGRAPH_LENGTH` with `MAX_RICH_TEXT_RUNS_PER_BLOCK` and `MAX_BLOCKS_PER_REQUEST`, both 100 per the Notion API, with the current 95 kept as a safety margin under an explicit name.
- **Verify:** unit tests on the paragraph-compression helpers.

#### Step 4.3 — Delete the dead loop
- **Change:** remove the `items[0].feed = feed` loop (#12).
- **Verify:** unit test that `matchFeedFilter` never reads `item.feed`.

### Phase 5 — Operations (homelab repo, not this one)

#### Step 5.1 — Stop the double logging
- **Change:** add `LogDriver=passthrough` to `containers/notion-feeder/notion-feeder.container` so conmon writes straight to the unit's journal stream instead of the output being captured by both conmon and podman.
- **Verify:** `journalctl -o json | group by _COMM` shows one writer, and line counts halve.
- **Value:** halves the journald volume for this unit and removes a genuinely confusing artifact — it read like the sync was running twice.

---

## Non-goals

- **Removing webpack.** Measured and rejected: it produces a 5.7 MB single-file bundle and keeps `node_modules` out of the 173 MB runtime image.
- **Rewriting in TypeScript.** Not justified at 670 lines; Phase 1's test harness buys most of the same confidence for far less churn.
- **Changing the Notion schema.** Phase 3.3 uses the `Parse quality` property that already exists.
- **Feed curation.** Which feeds to keep is a content decision, not a refactor.

---

## Open questions

1. **Is the 30-day unread retention actually wanted?** Step 2.3 hinges on it, and the backlog is 10,000+ rows. The function has existed, uncalled, since before this deployment — it may have been disabled on purpose.
2. **Is the 10,000 ceiling Notion's or the integration's?** The evidence is strong but circumstantial (`has_more: false` on a perfectly full 100th page, plus the contradictory filtered counts). Step 2.1 makes it moot rather than answering it. Worth confirming against Notion's API docs before relying on any other unbounded query.
3. **How far beyond 10,000 has the reader DB actually grown?** Unknown, and unknowable through the paginated query. A filtered count per month would establish it.
