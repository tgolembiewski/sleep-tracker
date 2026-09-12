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

Garmin's token endpoint reports refresh_token_expires_in as 2591999 seconds,
so the blob stops working 30 days after this login. A refresh mints a
replacement with a fresh 30 days, but the workflow reads the same secret every
run and never writes the replacement back, which fixes the deadline at the
moment the secret was set. The app counts down to it and shows the steps
above; re-run this script before it runs out.
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
