#!/usr/bin/env python3
"""Create or update a Hugging Face Docker Space from this repository.

Why a script rather than the `hf` CLI: the CLI imports the `venv` module at
start-up, which the bundled Python on some machines does not ship. The library
API below needs nothing beyond `pip install huggingface_hub`.

What it does, in order:

1. collects the repository's **tracked** files with `git ls-files`, so anything
   git-ignored — `.env`, `data/`, `node_modules`, `.next` — cannot be uploaded
   even by accident;
2. writes the Space's `README.md` with the YAML header Hugging Face requires
   (`sdk: docker`, `app_port: 7860`);
3. creates the Space and uploads that staging folder.

The token is read from `HF_TOKEN` or from the token file the CLI writes, so it
never has to appear on a command line. Nothing here prints it.

    python scripts/deploy-huggingface.py --repo <user>/<space-name> --dry-run
    python scripts/deploy-huggingface.py --repo <user>/<space-name>
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

SPACE_README = """---
title: Second Brain
emoji: \U0001f9e0
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# Second Brain

A local-first personal knowledge and memory system: capture notes, files, web pages,
mail and chat, then search across all of it, ask questions with citations, and automate
the recurring write-ups.

**Read this before putting anything in it.** A Space is a demonstration host, not a home
for your memory:

- the disk is **ephemeral**, so the memory resets whenever the Space restarts or is paused;
- it runs with `SB_API_DISABLE_AUTH=1`, because the browser UI has no login screen and the
  Space proxy makes every request look non-local. Anyone who can reach the URL can read
  *and write* the whole memory;
- keep it private, and keep personal data out of it.

`docs/huggingface.md` in the source repository has the details, and `docs/deployment.md`
covers running it somewhere that keeps your data.
"""


def tracked_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def stage(destination: Path) -> list[str]:
    """Copies the tracked files into `destination` and adds the Space README."""
    copied: list[str] = []
    for relative in tracked_files():
        source = REPO_ROOT / relative
        if not source.is_file():
            continue
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied.append(relative)
    (destination / "README.md").write_text(SPACE_README, encoding="utf-8")
    copied.append("README.md (Space header, generated)")
    return copied


def main() -> int:
    parser = argparse.ArgumentParser(description="Deploy this repository as a Hugging Face Docker Space.")
    parser.add_argument("--repo", required=True, help="Space id, for example <user>/second-brain")
    parser.add_argument("--public", action="store_true", help="create a public Space (default: private)")
    parser.add_argument("--dry-run", action="store_true", help="stage the upload and stop before any network call")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="sb-space-") as tmp:
        destination = Path(tmp)
        copied = stage(destination)
        print(f"staged {len(copied)} files from the repository's tracked set")

        forbidden = [name for name in copied if name.startswith("data/") or name in {".env"}]
        if forbidden:
            print(f"refusing to continue: personal data or secrets staged ({', '.join(forbidden)})", file=sys.stderr)
            return 3

        if args.dry_run:
            print(f"\ndry run — nothing uploaded. {len(copied)} files would go to {args.repo}:")
            for name in copied[:25]:
                print(f"  {name}")
            if len(copied) > 25:
                print(f"  … and {len(copied) - 25} more")
            return 0

        try:
            from huggingface_hub import HfApi
        except ImportError:
            print("huggingface_hub is not installed: pip install huggingface_hub", file=sys.stderr)
            return 2

        api = HfApi()
        if api.token is None:
            print(
                "no Hugging Face token found. Set HF_TOKEN in this shell, or sign in with the CLI first.",
                file=sys.stderr,
            )
            return 2

        url = api.create_repo(
            repo_id=args.repo,
            repo_type="space",
            space_sdk="docker",
            private=not args.public,
            exist_ok=True,
        )
        print(f"space ready: {url} (private={not args.public})")

        api.upload_folder(
            folder_path=str(destination),
            repo_id=args.repo,
            repo_type="space",
            commit_message="Deploy Second Brain",
        )
        print("uploaded — watch the build on the Space's Logs tab")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
