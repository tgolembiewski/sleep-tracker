#!/usr/bin/env python3
"""Fetch Garmin sleep score and overnight Body Battery change into docs/data.json.

Authentication uses a token blob rather than a password. Create the blob once
with ``scripts/garmin_login.py`` and expose it as the ``GARMIN_TOKENS``
environment variable (a GitHub Actions secret in CI, or a local export).

The script fetches a trailing window of days on every run so that late watch
syncs are picked up, and merges the result into the existing data file without
ever deleting days it did not fetch.

    GARMIN_TOKENS="..." python scripts/fetch_garmin.py --days 7
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from garminconnect import Garmin

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = REPO_ROOT / "docs" / "data.json"


def dig(source: Any, *path: str) -> Any:
    """Walk a chain of dict keys, returning None as soon as one is missing."""
    current = source
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def clock(local_ms: Any) -> str | None:
    """Garmin's *Local timestamps are epochs pre-shifted to the wearer's zone,
    so reading them as UTC yields the wall-clock time shown on the watch."""
    if not isinstance(local_ms, (int, float)):
        return None
    moment = dt.datetime.fromtimestamp(local_ms / 1000, dt.timezone.utc)
    return moment.strftime("%H:%M")


REFRESH_TOKEN_DAYS = 30  # what Garmin reports as refresh_token_expires_in


def token_expiry(blob: str) -> str | None:
    """The day the token blob stops working, as an ISO date.

    Garmin issues the access and refresh tokens together, so the ``iat`` inside
    the access token is also the refresh token's birthday, and the refresh
    token lasts 30 days from there. Each refresh mints a replacement with a
    fresh 30 days, but the workflow reads the same secret on every run and
    never writes the replacement back, so the deadline is fixed at the moment
    the secret was set. Returns None rather than raising: a blob we cannot read
    should cost us the warning, not the sync.
    """
    try:
        text = blob.strip()
        if not text.startswith("{"):
            text = base64.b64decode(text).decode("utf-8")
        payload = json.loads(text)["di_token"].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        issued = dt.datetime.fromtimestamp(claims["iat"], dt.timezone.utc)
    except Exception:  # noqa: BLE001 - malformed blob, nothing to report
        return None
    return (issued + dt.timedelta(days=REFRESH_TOKEN_DAYS)).date().isoformat()


def connect() -> Garmin:
    tokens = os.environ.get("GARMIN_TOKENS", "").strip()
    client = Garmin()
    if tokens:
        client.login(tokens)
    else:
        # Falls back to the token directory written by a previous local login.
        client.login(os.environ.get("GARMINTOKENS", "~/.garminconnect"))
    return client


def sleep_summary(client: Garmin, date: str) -> dict[str, Any]:
    """Everything the tracker needs about the night ending on `date`.

    Garmin's daily sleep response already carries the overnight Body Battery
    series and its net change, so one request covers both rows of the sheet.
    """
    raw = client.get_sleep_data(date) or {}
    daily = raw.get("dailySleepDTO") or {}

    score = dig(daily, "sleepScores", "overall", "value")
    if score is None:
        score = daily.get("sleepScore")

    # Sampled roughly every three minutes from sleep onset to wake-up.
    series = sorted(
        (
            (point.get("startGMT"), point.get("value"))
            for point in raw.get("sleepBodyBattery") or []
            if isinstance(point, dict)
            and isinstance(point.get("startGMT"), (int, float))
            and isinstance(point.get("value"), (int, float))
        ),
        key=lambda point: point[0],
    )

    bb_start = int(series[0][1]) if series else None
    bb_end = int(series[-1][1]) if series else None

    # Garmin publishes the same figure the app shows as "Sleep +57"; prefer it
    # over subtracting the endpoints ourselves.
    change = raw.get("bodyBatteryChange")
    if isinstance(change, (int, float)):
        bb_delta = int(round(change))
    elif bb_start is not None and bb_end is not None:
        bb_delta = bb_end - bb_start
    else:
        bb_delta = None

    return {
        "score": score,
        "qualifier": dig(daily, "sleepScores", "overall", "qualifierKey"),
        "duration_s": daily.get("sleepTimeSeconds"),
        "sleep_start": clock(daily.get("sleepStartTimestampLocal")),
        "sleep_end": clock(daily.get("sleepEndTimestampLocal")),
        "bb_start": bb_start,
        "bb_end": bb_end,
        "bb_delta": bb_delta,
    }


def find_sleep_event_impact(events: Any) -> int | None:
    """Pull Garmin's own 'Sleep +57' figure out of the body battery event feed.

    Only used when the sleep response arrives without Body Battery data. The
    event payload has changed shape across Garmin releases, so this walks the
    whole structure rather than assuming a fixed nesting.
    """
    found: list[int] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            event_type = str(
                node.get("eventType") or dig(node, "event", "eventType") or ""
            ).lower()
            impact = node.get("bodyBatteryImpact")
            if impact is None:
                impact = dig(node, "event", "bodyBatteryImpact")
            if "sleep" in event_type and isinstance(impact, (int, float)):
                found.append(int(round(impact)))
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(events)
    return found[0] if found else None


def day_steps(client: Garmin, date: str) -> int | None:
    """Steps walked on `date` itself — daytime activity, not part of the night.

    A separate request from the sleep summary, so a failure here must not cost
    us the sleep figures.
    """
    try:
        stats = client.get_stats(date) or {}
    except Exception as error:  # noqa: BLE001 - steps are a nice-to-have
        print(f"  steps unavailable for {date}: {error}")
        return None

    steps = stats.get("totalSteps")
    return int(steps) if isinstance(steps, (int, float)) else None


def collect_day(client: Garmin, date: str) -> dict[str, Any] | None:
    sleep = sleep_summary(client, date)
    bb_delta = sleep["bb_delta"]

    if bb_delta is None:
        try:
            bb_delta = find_sleep_event_impact(client.get_body_battery_events(date))
        except Exception as error:  # noqa: BLE001 - fallback endpoint is optional
            print(f"  body battery events unavailable for {date}: {error}")

    steps = day_steps(client, date)

    if sleep["score"] is None and bb_delta is None and steps is None:
        return None

    record: dict[str, Any] = {"sleepScore": sleep["score"], "bbDelta": bb_delta}
    if steps is not None:
        record["steps"] = steps
    if sleep["bb_start"] is not None and sleep["bb_end"] is not None:
        record["bbStart"] = sleep["bb_start"]
        record["bbEnd"] = sleep["bb_end"]
    if sleep["sleep_start"] and sleep["sleep_end"]:
        record["sleepStart"] = sleep["sleep_start"]
        record["sleepEnd"] = sleep["sleep_end"]
    if sleep["qualifier"]:
        record["qualifier"] = sleep["qualifier"]
    if sleep["duration_s"]:
        record["sleepSeconds"] = sleep["duration_s"]
    return record


def dump_raw(client: Garmin, date: str, path: Path) -> None:
    """Write Garmin's untouched responses so field names can be checked."""
    previous = (dt.date.fromisoformat(date) - dt.timedelta(days=1)).isoformat()
    raw: dict[str, Any] = {"date": date}

    for name, call in (
        ("sleep", lambda: client.get_sleep_data(date)),
        ("body_battery", lambda: client.get_body_battery(previous, date)),
        ("body_battery_events", lambda: client.get_body_battery_events(date)),
    ):
        try:
            raw[name] = call()
        except Exception as error:  # noqa: BLE001 - debugging aid only
            raw[name] = {"error": str(error)}

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(raw, indent=2, ensure_ascii=False, default=str), encoding="utf-8"
    )
    print(f"Raw responses for {date} written to {path}\n")


def load_existing(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"generatedAt": None, "days": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print(f"{path} was not valid JSON, starting a fresh file")
        return {"generatedAt": None, "days": {}}
    data.setdefault("days", {})
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--days", type=int, default=7, help="how many trailing days to refetch"
    )
    parser.add_argument("--end", default=None, help="last date to fetch (YYYY-MM-DD)")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--dump-raw",
        type=Path,
        default=None,
        help="also write Garmin's untouched responses here, for debugging",
    )
    parser.add_argument(
        "--skip-if-complete",
        action="store_true",
        help="exit without contacting Garmin when every requested day already "
        "has a sleep score on file",
    )
    args = parser.parse_args()

    end = dt.date.fromisoformat(args.end) if args.end else dt.date.today()
    dates = [
        (end - dt.timedelta(days=offset)).isoformat()
        for offset in range(args.days - 1, -1, -1)
    ]

    # Only the secret's own blob may set this. A local run authenticates from
    # ~/.garminconnect, which is a different token chain on a different clock,
    # and would otherwise overwrite the date the app warns against.
    expiry = token_expiry(os.environ.get("GARMIN_TOKENS", ""))

    if args.skip_if_complete:
        # Lets the morning poll run every quarter of an hour while still hitting
        # Garmin only until the night actually shows up.
        known = load_existing(args.output)
        if all(
            (known.get("days", {}).get(date) or {}).get("sleepScore") is not None
            for date in dates
        ):
            print("Every requested day already has a sleep score, nothing to do.")
            # A renewed secret must still reach the app today, not whenever the
            # next run happens to have work to do.
            if expiry and known.get("tokenExpires") != expiry:
                known["tokenExpires"] = expiry
                args.output.write_text(
                    json.dumps(known, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
                print(f"Token blob expires {expiry}.")
            return 0

    try:
        client = connect()
    except Exception as error:  # noqa: BLE001 - surface auth failures clearly
        print(f"Garmin login failed: {error}", file=sys.stderr)
        print(
            "Re-run scripts/garmin_login.py and update the GARMIN_TOKENS secret.",
            file=sys.stderr,
        )
        return 1

    if args.dump_raw:
        dump_raw(client, dates[-1], args.dump_raw)

    data = load_existing(args.output)
    changed = 0
    if expiry:
        # A plain date, so a run that renews nothing leaves the file
        # byte-identical and the workflow commits nothing.
        data["tokenExpires"] = expiry

    for index, date in enumerate(dates):
        try:
            record = collect_day(client, date)
        except Exception as error:  # noqa: BLE001 - one bad day must not abort
            print(f"{date}: fetch failed ({error})")
            continue

        if record is None:
            print(f"{date}: no sleep recorded")
            continue

        if data["days"].get(date) != record:
            data["days"][date] = record
            changed += 1
        battery = (
            f"body battery {record['bbDelta']:+d}"
            if record["bbDelta"] is not None
            else "body battery unknown"
        )
        walked = f", {record['steps']} steps" if record.get("steps") is not None else ""
        print(f"{date}: sleep score {record['sleepScore']}, {battery}{walked}")

        if index < len(dates) - 1:
            time.sleep(1)  # stay well under Garmin's rate limit

    if changed:
        # Stamped only on a real change, so an unchanged file stays byte-identical
        # and the workflow does not commit a new timestamp three times a day.
        data["generatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat(
            timespec="seconds"
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"\n{changed} day(s) updated in {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
