#!/usr/bin/env python3
"""One-time interactive Garmin Connect login.

Run this on your own machine (never in CI). It performs the full SSO login,
including MFA if your account requires it, and saves the resulting tokens to
``~/.garminconnect``. The workflow authenticates with those tokens instead of
your password, which never leaves this machine.

    python scripts/garmin_login.py

Afterwards, hand the tokens straight to GitHub without them passing through
your scrollback or your clipboard:

    python scripts/garmin_login.py --show-tokens | gh secret set GARMIN_TOKENS

The OAuth1 token inside the blob is valid for roughly one year; the OAuth2
token refreshes itself automatically. Re-run this script when the workflow
starts failing with an authentication error.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys

from garminconnect import Garmin

TOKEN_DIR = os.path.expanduser("~/.garminconnect")

SECRET_COMMAND = (
    "python scripts/garmin_login.py --show-tokens | gh secret set GARMIN_TOKENS"
)


def show_tokens() -> int:
    """Print the token blob and nothing else, for piping into `gh secret set`."""
    if not os.path.isdir(TOKEN_DIR):
        print(
            f"No tokens in {TOKEN_DIR}. Run this script without --show-tokens first.",
            file=sys.stderr,
        )
        return 1

    client = Garmin()
    client.client.load(TOKEN_DIR)
    print(client.client.dumps())
    return 0


def interactive_login() -> int:
    email = input("Garmin Connect e-mail: ").strip()
    password = getpass.getpass("Garmin Connect password: ")

    client = Garmin(email, password, prompt_mfa=lambda: input("MFA code: ").strip())
    client.login()
    client.client.dump(TOKEN_DIR)

    print()
    print(f"Logged in as: {client.get_full_name()}")
    print(f"Tokens saved to {TOKEN_DIR}.")
    print()
    print("Now hand them to GitHub, without them passing through your clipboard:")
    print()
    print(f"    {SECRET_COMMAND}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--show-tokens",
        action="store_true",
        help="print the saved token blob and nothing else",
    )
    args = parser.parse_args()

    return show_tokens() if args.show_tokens else interactive_login()


if __name__ == "__main__":
    sys.exit(main())
