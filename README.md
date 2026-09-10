# Tracker nawyków snu

A 28-day sleep habit tracker that installs to the home screen of an iPhone or
iPad and fills in two rows for you every morning: the **Garmin Sleep Score** and
the **net Body Battery change during sleep** (level at wake-up minus level at
sleep onset).

Everything runs on free GitHub infrastructure. There is no server to rent and
nothing that has to stay switched on at home:

| Piece | Role |
| --- | --- |
| `scripts/fetch_garmin.py` | Reads Garmin Connect through `python-garminconnect` and writes `docs/data.json` |
| `.github/workflows/garmin-sync.yml` | Runs that script three times each morning and commits the result |
| `docs/` | The installable web app, served by GitHub Pages |

`docs/seed.json` carries the entries transcribed from the paper sheet. A device
opening the app for the first time loads it automatically; on a device that
already has data, **⚙ → Wczytaj arkusz startowy** imports it. The import only
fills blanks, so anything already entered on that device is never overwritten
and running it twice changes nothing.

Habit checkmarks, morning energy ratings and daily notes live in the browser's
`localStorage` on each device. The Garmin numbers arrive over the network and
are cached for offline use. A value you type by hand always wins and is never
overwritten by a later sync.

## Setup

### 1. Create the repository

```bash
gh repo create sleep-tracker --public --source=. --remote=origin --push
```

GitHub Pages needs a public repository on the free plan, which means
`docs/data.json` — your sleep scores and Body Battery figures — will be readable
by anyone who knows the URL. If you would rather keep it private, GitHub Pages
on private repositories requires a paid plan.

### 2. Log in to Garmin once, locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/garmin_login.py
```

The script asks for your Garmin e-mail, password and (if enabled) an MFA code,
then saves the resulting tokens to `~/.garminconnect`. Hand them to GitHub with:

```bash
.venv/bin/python scripts/garmin_login.py --show-tokens | gh secret set GARMIN_TOKENS
```

Piping keeps the blob out of your scrollback and your clipboard. Your password
is never stored and never reaches GitHub. The OAuth1 token inside the blob lasts
about a year; re-run the login when the workflow starts failing to
authenticate.

### 3. Turn on GitHub Pages

**Settings → Pages → Source: Deploy from a branch**, branch `main`, folder
`/docs`. After a minute the app is live at
`https://<user>.github.io/sleep-tracker/`.

### 4. Check the fetch against your own account first

```bash
.venv/bin/python scripts/fetch_garmin.py --days 3 --output /tmp/test.json --dump-raw /tmp/garmin-raw.json
```

`--dump-raw` writes Garmin's untouched responses next to the parsed result. If a
day comes back as `body battery unknown`, that file shows which field names
Garmin is actually using so the parser can be adjusted.

### 5. Run the sync once

**Actions → Garmin sync → Run workflow.** It fetches the last seven days and
commits `docs/data.json` if anything changed.

From then on it polls every 15 minutes between 05:00 and 11:59 UTC, so the
night lands in the app shortly after your watch syncs. Cron does not follow
daylight saving, so that window is the union of both Polish offsets: 07:00 to
13:59 in summer and 06:00 to 12:59 in winter, which covers waking any time
between 07:00 and 11:00 in either season.

Each of those runs asks Garmin for one day only, and skips the call entirely
once that day's sleep score is already on file, so a normal morning costs two or
three requests rather than dozens. A single wider pass at 15:00 UTC refetches
the last seven days to pick up a watch that synced late.

To shift the window, edit the first `cron` line in
`.github/workflows/garmin-sync.yml`. `*/15 5-11 * * *` means "every 15 minutes
during UTC hours 5 through 11"; subtract two from your earliest local summer
wake-up hour to get the UTC hour to start at, and one from your latest to get
the hour to end at.

### 6. Install on the phone

Open the Pages URL in **Safari** (not Chrome — only Safari can install to the
home screen on iOS), tap **Share → Add to Home Screen**. Repeat on the iPad.

The installed app keeps its own storage, separate from the Safari tab you used
to install it, so start entering data only after installing.

## Running the fetch locally

```bash
.venv/bin/python scripts/fetch_garmin.py --days 14
```

With no `GARMIN_TOKENS` in the environment it falls back to the token directory
that `garmin_login.py` left in `~/.garminconnect`.

Useful flags: `--days N` for a longer backfill, `--end YYYY-MM-DD` to fetch a
window that ended in the past, `--output PATH` to write elsewhere.

## Data file format

```json
{
  "generatedAt": "2026-09-07T05:03:11+00:00",
  "days": {
    "2026-09-07": {
      "sleepScore": 82,
      "bbDelta": 53,
      "bbStart": 12,
      "bbEnd": 65,
      "sleepStart": "23:13",
      "sleepEnd": "07:02",
      "qualifier": "GOOD",
      "sleepSeconds": 27000
    }
  }
}
```

Days are keyed by the morning you woke up, matching how Garmin Connect files a
night, and matching the column you would tick on the paper sheet.

## The unlock screen

`scripts/set_passcode.py` asks for a passphrase and writes only a salted
PBKDF2-SHA256 verifier to `docs/gate.json`; the passphrase itself is never
stored. The app asks for it once per device and remembers it afterwards.
Changing it re-locks every device.

This hides the interface. It is **not** a security boundary: the site is served
from a public repository, so `docs/data.json` and `docs/seed.json` stay readable
by anyone who requests those URLs directly. Protecting the numbers themselves
would mean encrypting the data files, or moving to a host that enforces
authentication server-side.

## Things worth knowing

- On a phone the grid holds all 28 days at a fixed 66 px per column and scrolls
  sideways with the habit names pinned; `T1`–`T4` and `Dziś` jump to a week, and
  those jumps are measured from the DOM rather than computed as
  `index * 66`, so they cannot drift out of alignment with the pinned column.
  A screen 900 px or wider keeps the whole 28-day grid on show, unchanged.
- Habit data lives only in `localStorage`. Clearing Safari website data, or
  deleting the installed app, deletes the tracker's history with it. The iPhone
  and the iPad keep separate copies and do not sync.
- Both numbers come out of a single `get_sleep_data` call: `bodyBatteryChange`
  is the same figure the Garmin Connect app prints as "Sleep +57", and
  `sleepBodyBattery` is the overnight series whose first and last points become
  `bbStart` and `bbEnd`. The `get_body_battery` endpoint is deliberately not
  used — it returns only about six samples per day, too coarse to place sleep
  onset accurately.
- `python-garminconnect` talks to Garmin's private endpoints, not a documented
  public API. Garmin can change them at any time; if the workflow starts
  returning empty days, upgrade the pinned version in `requirements.txt`.
- The workflow deliberately re-fetches a rolling seven-day window once a day,
  because a watch that syncs late would otherwise leave a permanent gap.
- GitHub's scheduled runs are queued on shared runners and typically start five
  to twenty minutes after the nominal time, occasionally later. Treat the
  morning window as "within half an hour of waking", not as an alarm clock. The
  app also refetches whenever you open or return to it, so pulling it up after
  breakfast always shows the newest data.
- GitHub disables scheduled workflows in repositories with no activity for 60
  days. This one commits most days, which counts as activity.

## Regenerating the icons

```bash
python3 scripts/make_icons.py
```
