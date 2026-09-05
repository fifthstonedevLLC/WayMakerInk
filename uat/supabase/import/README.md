# Importing the Sheet history

One-time scripts that clear the test data and load the 42 exported Google Sheet
rows, so both artists open the portal to their real request history rather than
to an empty queue.

**These are not migrations.** They live outside `../migrations/` on purpose: the
Supabase CLI runs everything in that directory, in filename order, on every
`db push` and `db reset`. A `truncate` in there would fire on a reset, and the
data load would replay on top of live rows. Nothing here runs unless you run it.

---

## Order

| | File | |
|---|---|---|
| 0 | [`00-preflight.sql`](00-preflight.sql) | Read-only. Which database, what dies, what survives. |
| 1 | [`01-clear-request-data.sql`](01-clear-request-data.sql) | 🔴 Destroys all request data. Keeps artists, tiers, prices, profiles. |
| 2 | [`02-import-existing-requests.sql`](02-import-existing-requests.sql) | Loads the export. Idempotent. |

⚠ **Step 0 is not optional, and it is a separate file for a reason.** The
Supabase SQL Editor commits a whole file as one batch. A count printed above a
`truncate` in the same file reports *after* the table is empty, with no prompt
in between — it looks like a safety check and cannot act as one. So the looking
is its own step.

Pay particular attention to preflight query 5: any real client request that
arrived while UAT was live is **not** in the Sheet export and will not come
back.

Both run as `postgres` — SQL Editor or `psql`. There is no insert policy on
`public.requests` and no delete policy at all; intake and respond are functions
writing as `service_role`, so an ordinary authenticated session can do neither,
by design.

⚠ **Step 2 is not in the repo, and neither is the export it is built from.**
Both are gitignored: the export is 42 real client records — names, addresses,
phone numbers, free-text descriptions — and step 2 embeds that payload verbatim.
Committing either writes 35 people's contact details into git history, where
deleting the file does not remove them.

Generate step 2 from your own copy of the export:

```sh
node build-import-sql.js
```

It reads `../migrations/existing_client_data_migration.json` and writes
`02-import-existing-requests.sql` beside itself. Re-run it after a fresh export;
the expected counts in its verify block are derived from the data, so they
follow along on their own.

---

## Rehearse it locally first

⚠ **These scripts have not been executed against a live database.** They are
checked against the schema by hand — every column, constraint and check —
and the payload is verified to round-trip intact, but that is not the same as
having run. Prove them on the local stack, where a mistake costs a `db reset`:

```sh
npx supabase start
npx supabase db reset                       # schema + reference seed, no requests
psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2-)" \
  -f 01-clear-request-data.sql -f 02-import-existing-requests.sql
```

Read the verify output at the bottom. Then open the portal against local and
look at both artists' queues. Only after that, run it on the hosted project.

The clear script is a no-op on a freshly reset local database, which is the
point — you are rehearsing step 2 against the real schema, not the real data.

## Before step 1 on the hosted project

```sh
npx supabase db dump --data-only -f pre-import-backup.sql   # take it anyway
npx supabase projects list                                  # which project is linked?
```

⚠ The repo carries settings for a hosted UAT project **and** a local stack on
`:54321`. Neither script knows which one you have open. Run
`select current_database(), now();` in the editor you are about to use.

⚠ Requests submitted between step 1 and step 2 are lost, and are being
re-entered by hand. The window opens the moment step 1 commits.

---

## What the import does

42 source rows → **40 requests**.

### The two that are dropped

`WMI-MSXCC5I2-W4EB4H` and `WMI-MTHNJJ4K-CNENMQ` each appear twice: byte-identical
submissions, one answered by the artist and one left at `NEW`. These are the
retry duplicates the sheet could not prevent and the `unique (rid)` constraint
now does — the form holds one rid across all three retry attempts, and intake
turns a conflict into a 200 rather than a second row.

The answered copy is kept. Importing both is impossible; importing the wrong one
would erase a decision that was really made.

### Value changes

The sheet stored what a person reads. The schema stores what code branches on,
and the portal renders the label. Each of these is a transformation the intake
function already does at the door for live traffic:

| Sheet | Column | Becomes |
|---|---|---|
| `LINK SENT` | `status` | `LINK_SENT` — no spaces, ever |
| `''` | `service` | `tattoo` — every exported row predates the service column |
| `Yes` / `No` | `first_time` | a real boolean |
| `''` | `minor_age` | `NULL`, not `0` |
| `''` | `tier_sent` | `NULL`, not `''` |
| `''` | `heard_from` | `Not given` |

`tier_sent` is the one worth understanding. `requests_decided_has_decision`
tests `tier_sent is not null`, so importing `''` would let a `LINK_SENT` row
satisfy the constraint while naming no tier at all — a row that reads as
answered and cannot say with what.

### What does not come across

**The reference images.** They are in Drive, not Storage, and there is nothing
to point `request_images` at. `reference_count` is imported honestly anyway, so
the portal shows `0 of 2 loaded` rather than pretending the client sent nothing
— it already renders that mismatch as a warning, which is the correct thing for
an artist to see. The Drive folder *name* is preserved on each row's `migrated`
event, so the originals stay findable.

**`booking_url`.** The sheet recorded which tier was sent, never which Acuity
URL. `tier_sent` is the closest record there is.

**`decided_by`.** These decisions were made in the old system by someone with no
`auth.users` row. Inventing an actor in an audit table is worse than a null.

### Provenance

Every imported request gets one `request_events` row, `event = 'migrated'`,
carrying the sheet row number, the original status string, the Drive folder
name, and the artist name and email the sheet held. Nothing in the export is
discarded without being written down somewhere.

---

## Verifying

The import file ends with three queries. Expected:

- `requests` = 40, `migrated` events = 40
- per artist/status: `laynie` 7 `LINK_SENT` + 6 `NEW`, `nic` 25 `LINK_SENT` +
  1 `DECLINED` + 1 `NEW`
- the third query returns **nothing**

Then open the portal as each artist and confirm the queue is theirs. RLS scopes
reads through `can_see_artist(artist_key)`, so an artist sees their own rows and
an admin sees both.

⚠ The counts above are after de-duplication — both dropped rows were `NEW`, so
`laynie` loses one and `nic` loses one against the raw sheet totals.
