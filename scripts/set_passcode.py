#!/usr/bin/env python3
"""Set the passphrase that unlocks the app on a device.

Run this locally and type the passphrase at the prompt; it never appears on
screen and is never stored. Only a salted PBKDF2 verifier is written to
``docs/gate.json``, which cannot be turned back into the passphrase.

    python scripts/set_passcode.py

Be clear about what this buys: the gate hides the app's interface, it does not
protect the published data. ``docs/data.json`` and ``docs/seed.json`` stay
readable by anyone who requests those URLs directly, because GitHub Pages on
the free plan serves from a public repository. To actually protect the numbers,
the data files would need to be encrypted.

Changing the passphrase re-locks every device, since each one remembers the
verifier it was unlocked against.
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import json
import secrets
import sys
from pathlib import Path

GATE_FILE = Path(__file__).resolve().parent.parent / "docs" / "gate.json"
ITERATIONS = 310_000  # OWASP guidance for PBKDF2-HMAC-SHA256
SALT_BYTES = 16
KEY_BYTES = 32


def derive(passphrase: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256", passphrase.encode("utf-8"), salt, ITERATIONS, KEY_BYTES
    )


def main() -> int:
    passphrase = getpass.getpass("Nowe hasło do aplikacji: ")
    if len(passphrase) < 6:
        print("Hasło musi mieć co najmniej 6 znaków.", file=sys.stderr)
        return 1

    if passphrase != getpass.getpass("Powtórz hasło: "):
        print("Hasła nie są identyczne.", file=sys.stderr)
        return 1

    salt = secrets.token_bytes(SALT_BYTES)
    gate = {
        "algorithm": "PBKDF2-HMAC-SHA256",
        "iterations": ITERATIONS,
        "salt": base64.b64encode(salt).decode("ascii"),
        "hash": base64.b64encode(derive(passphrase, salt)).decode("ascii"),
    }

    GATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    GATE_FILE.write_text(json.dumps(gate, indent=2) + "\n", encoding="utf-8")

    print(f"\nZapisano weryfikator w {GATE_FILE}")
    print("Commit i push, potem odblokuj aplikację na telefonie i iPadzie.")
    print("Zmiana hasła zablokuje ponownie wszystkie urządzenia.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
