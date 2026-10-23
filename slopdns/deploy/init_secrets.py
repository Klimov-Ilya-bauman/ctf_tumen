#!/usr/bin/env python3
"""Create private installation config; never overwrite an existing installation."""
import argparse
import os
from pathlib import Path
import secrets

PASSWORDS = {
    "POSTGRES_PASSWORD", "SLOPDNS_IAM_OWNER_DB_PASSWORD",
    "SLOPDNS_BACKEND_OWNER_DB_PASSWORD", "SLOPDNS_IAM_DB_PASSWORD",
    "SLOPDNS_BACKEND_DB_PASSWORD", "SLOPDNS_SYNC_DB_PASSWORD",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().with_name(".env"))
    args = parser.parse_args()
    template = Path(__file__).resolve().with_name(".env.example").read_text()
    lines = []
    for line in template.splitlines():
        key, sep, value = line.partition("=")
        if key in PASSWORDS:
            value = secrets.token_hex(32)
        lines.append(key + sep + value)
    try:
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        parser.error(f"{args.output} already exists; refusing to change existing database credentials")
    with os.fdopen(fd, "w") as stream:
        stream.write("\n".join(lines) + "\n")
    print(f"Created {args.output} (0600). For NEW databases only; see SECURITY_REPORT.md for upgrades.")


if __name__ == "__main__":
    main()
