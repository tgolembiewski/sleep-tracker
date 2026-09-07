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
    """Sleep score plus the GMT millisecond bounds of the night ending on date."""
    raw = client.get_sleep_data(date) or {}
    daily = raw.get("dailySleepDTO") or {}

    score = dig(daily, "sleepScores", "overall", "value")
    if score is None:
        score = daily.get("sleepScore")

    return {
        "score": score,
        "qualifier": dig(daily, "sleepScores", "overall", "qualifierKey"),
        "start_ms": daily.get("sleepStartTimestampGMT"),
        "end_ms": daily.get("sleepEndTimestampGMT"),
        "start_local_ms": daily.get("sleepStartTimestampLocal"),
        "end_local_ms": daily.get("sleepEndTimestampLocal"),
        "duration_s": daily.get("sleepTimeSeconds"),
    }


def find_sleep_event_impact(events: Any) -> int | None:
    """Pull Garmin's own 'Sleep +53' figure out of the body battery event feed.

    The event payload has changed shape across Garmin releases, so this walks
    the whole structure looking for a sleep event that carries an impact value
    rather than assuming a fixed nesting.
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


def level_index(day: dict[str, Any]) -> int:
    """Position of the battery level inside each bodyBatteryValuesArray entry.

    Garmin ships a descriptor list naming the columns; reading it keeps the
    parser working if the column order ever changes. Falls back to the layout
    Garmin has used so far: [timestamp, status, level, version].
    """
    descriptors = day.get("bodyBatteryValueDescriptorDTOList") or []
    for descriptor in descriptors:
        key = str(descriptor.get("bodyBatteryValueDescriptorKey") or "").lower()
        index = descriptor.get("bodyBatteryValueDescriptorIndex")
        if "level" in key and isinstance(index, int):
            return index
    return 2


def body_battery_series(client: Garmin, date: str) -> list[tuple[int, int]]:
    """(timestamp_ms, level) samples covering the night that ends on date."""
    previous = (dt.date.fromisoformat(date) - dt.timedelta(days=1)).isoformat()
    days = client.get_body_battery(previous, date) or []

    samples: list[tuple[int, int]] = []
    for day in days:
        index = level_index(day)
        for entry in day.get("bodyBatteryValuesArray") or []:
            if not isinstance(entry, list) or len(entry) <= index:
                continue
            timestamp, level = entry[0], entry[index]
            if isinstance(timestamp, (int, float)) and isinstance(level, (int, float)):
                samples.append((int(timestamp), int(level)))

    samples.sort()
    return samples


def level_at(samples: list[tuple[int, int]], target_ms: int) -> int | None:
    """Body battery level from the sample closest to target_ms, within 90 min."""
    if not samples or target_ms is None:
        return None
    timestamp, level = min(samples, key=lambda s: abs(s[0] - target_ms))
    if abs(timestamp - target_ms) > 90 * 60 * 1000:
        return None
    return level


def collect_day(client: Garmin, date: str) -> dict[str, Any] | None:
    sleep = sleep_summary(client, date)

    start_ms, end_ms = sleep["start_ms"], sleep["end_ms"]
    bb_start = bb_end = bb_delta = None

    if start_ms and end_ms:
        samples = body_battery_series(client, date)
        bb_start = level_at(samples, start_ms)
        bb_end = level_at(samples, end_ms)
        if bb_start is not None and bb_end is not None:
            bb_delta = bb_end - bb_start

    if bb_delta is None:
        # Garmin's own sleep event carries the same figure the app displays.
        try:
            bb_delta = find_sleep_event_impact(client.get_body_battery_events(date))
        except Exception as error:  # noqa: BLE001 - endpoint is optional
            print(f"  body battery events unavailable for {date}: {error}")

    if sleep["score"] is None and bb_delta is None:
        return None

    record: dict[str, Any] = {"sleepScore": sleep["score"], "bbDelta": bb_delta}
    if bb_start is not None:
        record["bbStart"] = bb_start
    if bb_end is not None:
        record["bbEnd"] = bb_end
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

    if args.skip_if_complete:
        # Lets the morning poll run every quarter of an hour while still hitting
        # Garmin only until the night actually shows up.
        known = load_existing(args.output).get("days", {})
        if all((known.get(date) or {}).get("sleepScore") is not None for date in dates):
            print("Every requested day already has a sleep score, nothing to do.")
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
        print(
            f"{date}: sleep score {record['sleepScore']}, "
            f"body battery {record['bbDelta']:+d}"
            if record["bbDelta"] is not None
            else f"{date}: sleep score {record['sleepScore']}, body battery unknown"
        )

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
