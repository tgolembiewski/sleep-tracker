#!/usr/bin/env python3
"""One-time interactive Garmin Connect login.

Run this on your own machine (never in CI). It performs the full SSO login,
including MFA if your account requires it, then prints a base64 token blob.
Store that blob as the GitHub Actions secret ``GARMIN_TOKENS`` so the nightly
workflow can authenticate without ever seeing your password.

The OAuth1 token inside the blob is valid for roughly one year; the OAuth2
token refreshes itself automatically. Re-run this script when the workflow
starts failing with an authentication error.

    python scripts/garmin_login.py
"""

from __future__ import annotations

import getpass
import os
import sys

from garminconnect import Garmin

TOKEN_DIR = os.path.expanduser("~/.garminconnect")


def main() -> int:
    email = input("Garmin Connect e-mail: ").strip()
    password = getpass.getpass("Garmin Connect password: ")

    client = Garmin(email, password, prompt_mfa=lambda: input("MFA code: ").strip())
    client.login()

    tokens = client.client.dumps()
    client.client.dump(TOKEN_DIR)
    profile = client.get_full_name()

    print()
    print(f"Logged in as: {profile}")
    print(f"Tokens also saved to {TOKEN_DIR} for local runs.")
    print()
    print("Add the following as a GitHub Actions secret named GARMIN_TOKENS")
    print("(Settings -> Secrets and variables -> Actions -> New repository secret).")
    print("Copy everything between the marker lines, without the markers.")
    print()
    print("----- BEGIN GARMIN_TOKENS -----")
    print(tokens)
    print("----- END GARMIN_TOKENS -----")
    return 0


if __name__ == "__main__":
    sys.exit(main())
