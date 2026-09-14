# Cloudflare Worker: trigger the Garmin sync on time

GitHub Actions will not run a schedule in the morning window on a free public
repository. Across 12-14 September it granted no slot at all between 05:00 and
11:00 UTC, three days running, while firing afternoon and evening slots freely.
That window is the whole point: it is when the night becomes available.

A `workflow_dispatch` through the API is not throttled the same way, so this
Worker does nothing but make that call on a schedule Cloudflare keeps.

## What you need

* A Cloudflare account (the free plan is enough: 5 cron triggers, 100,000
  requests a day; this makes one small POST per fire).
* A GitHub fine-grained personal access token, repository access limited to
  `sleep-tracker`, permission **Actions: Read and write**. The same token the
  app's refresh button uses will do.
* A phrase of your own choosing for `TRIGGER_KEY`, so the Worker's public URL
  is not a button for anyone who finds it.

Neither secret belongs in this repository. Both are set in the Cloudflare
dashboard, which keeps them encrypted.

## Setting it up

1. **Workers & Pages -> Create -> Worker**. Give it a name, for example
   `garmin-sync-cron`, and deploy the placeholder it offers.
2. **Edit code**, replace everything with `worker.js` from this folder, deploy.
3. **Settings -> Variables and Secrets**, add two *secrets* (not plain text
   variables):
   * `GITHUB_TOKEN` - the token above
   * `TRIGGER_KEY` - your phrase
4. **Settings -> Triggers -> Cron Triggers -> Add**:

       7 5,6,7,8,9,10,11 * * *

   Cloudflare's cron is UTC and ignores daylight saving, so this window is the
   union of both Polish offsets: 07:00-13:00 in summer, 06:00-12:00 in winter.
   The odd minute keeps it off the contended :00 mark.

5. Prove it works without waiting for the hour, using your own key:

       curl "https://<worker>.<subdomain>.workers.dev/run?key=<TRIGGER_KEY>"

   `Sync dispatched.` means GitHub accepted it; check the repository's Actions
   tab for the run. A 404 means the key is wrong. A 502 carries GitHub's own
   status: 401 for a bad or expired token, 403 for a token without the Actions
   permission.

## Why it fires seven times

No fixed hour can know when the watch will sync - on 13 September it did not
upload until 10:40, so a single 09:00 trigger would have found nothing. The
dispatch passes `skip=true`, so a fire whose night is already on file exits
without contacting Garmin. One real fetch a day, six cheap confirmations.

## When it goes quiet

The Worker cannot tell you the token expired; GitHub simply refuses it. The
app is the place that notices - it warns when a night is missing and says why,
and counts down to the Garmin token's own 30-day deadline separately. Read the
Worker's own failures under **Workers -> your Worker -> Logs**.
