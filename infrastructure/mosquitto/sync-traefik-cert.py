#!/usr/bin/env python3
"""Extract a domain certificate from Traefik's ACME store for Mosquitto."""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--acme", type=Path, required=True)
    parser.add_argument("--domain", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--reload-label")
    parser.add_argument("--owner-uid", type=int)
    parser.add_argument("--owner-gid", type=int)
    return parser.parse_args()


def find_certificate(store: dict, domain: str) -> tuple[bytes, bytes]:
    for resolver in store.values():
        if not isinstance(resolver, dict):
            continue
        for item in resolver.get("Certificates", []):
            names = [item.get("domain", {}).get("main")]
            names.extend(item.get("domain", {}).get("sans") or [])
            if domain in names:
                return (
                    base64.b64decode(item["certificate"]),
                    base64.b64decode(item["key"]),
                )
    raise RuntimeError(f"certificate for {domain} was not found")


def replace_if_changed(path: Path, content: bytes, mode: int) -> bool:
    if path.exists() and path.read_bytes() == content:
        os.chmod(path, mode)
        return False
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary.write(content)
        temporary_path = Path(temporary.name)
    os.chmod(temporary_path, mode)
    os.replace(temporary_path, path)
    return True


def reload_matching_containers(label: str) -> int:
    result = subprocess.run(
        ["docker", "ps", "-q", "--filter", f"label={label}"],
        check=True,
        capture_output=True,
        text=True,
    )
    container_ids = result.stdout.split()
    for container_id in container_ids:
        subprocess.run(
            ["docker", "kill", "--signal", "HUP", container_id],
            check=True,
            capture_output=True,
        )
    return len(container_ids)


def main() -> None:
    args = arguments()
    store = json.loads(args.acme.read_text(encoding="utf-8"))
    certificate, private_key = find_certificate(store, args.domain)
    if b"-----BEGIN CERTIFICATE-----" not in certificate:
        raise RuntimeError("decoded certificate is not PEM")
    if b"-----BEGIN" not in private_key or b"PRIVATE KEY-----" not in private_key:
        raise RuntimeError("decoded private key is not PEM")

    args.output_dir.mkdir(parents=True, exist_ok=True, mode=0o750)
    certificate_changed = replace_if_changed(
        args.output_dir / "fullchain.pem", certificate, 0o644
    )
    key_changed = replace_if_changed(args.output_dir / "privkey.pem", private_key, 0o600)
    changed = certificate_changed or key_changed
    if args.owner_uid is not None or args.owner_gid is not None:
        uid = args.owner_uid if args.owner_uid is not None else -1
        gid = args.owner_gid if args.owner_gid is not None else -1
        os.chown(args.output_dir, uid, gid)
        os.chown(args.output_dir / "fullchain.pem", uid, gid)
        os.chown(args.output_dir / "privkey.pem", uid, gid)
    reloaded = 0
    if changed and args.reload_label:
        reloaded = reload_matching_containers(args.reload_label)
    print(json.dumps({"domain": args.domain, "changed": changed, "reloaded": reloaded}))


if __name__ == "__main__":
    main()
