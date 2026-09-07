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
then prints a token blob. Copy it into a repository secret named
`GARMIN_TOKENS` under **Settings → Secrets and variables → Actions**.

Your password is never stored anywhere and never reaches GitHub. The OAuth1
token inside the blob lasts about a year; re-run the script when the workflow
starts failing to authenticate.

### 3. Turn on GitHub Pages

**Settings → Pages → Source: Deploy from a branch**, branch `main`, folder
`/docs`. After a minute the app is live at
`https://<user>.github.io/sleep-tracker/`.

### 4. Run the sync once

**Actions → Garmin sync → Run workflow.** It fetches the last seven days and
commits `docs/data.json` if anything changed. From then on it runs on its own at
roughly 07:00, 10:00 and 13:00 Polish time.

### 5. Install on the phone

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
      "qualifier": "GOOD",
      "sleepSeconds": 27000
    }
  }
}
```

Days are keyed by the morning you woke up, matching how Garmin Connect files a
night, and matching the column you would tick on the paper sheet.

## Things worth knowing

- Habit data lives only in `localStorage`. Clearing Safari website data, or
  deleting the installed app, deletes the tracker's history with it. The iPhone
  and the iPad keep separate copies and do not sync.
- `python-garminconnect` talks to Garmin's private endpoints, not a documented
  public API. Garmin can change them at any time; if the workflow starts
  returning empty days, upgrade the pinned version in `requirements.txt`.
- The workflow deliberately re-fetches a rolling seven-day window, because a
  watch that syncs late would otherwise leave a permanent gap.

## Regenerating the icons

```bash
python3 scripts/make_icons.py
```
