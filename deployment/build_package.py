"""Create a shareable artifact ZIP without credentials or local session data."""
import argparse
from pathlib import Path
import zipfile


def included(path: Path) -> bool:
    excluded = {".git", ".venv", "__pycache__", "runtime", "verification"}
    if any(part in excluded for part in path.parts):
        return False
    if path.parts[:2] == ("data", "hitl") or path.as_posix() == "data/hitl_session_memory.json":
        return False
    if path.suffix in {".pyc", ".zip"}:
        return False
    return not (path.name.startswith(".env") and path.name != ".env.example")


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=root.parent / "wind-demo-deployment.zip")
    args = parser.parse_args()
    count = 0
    # Exclusive creation avoids overwriting an existing user artifact.
    with zipfile.ZipFile(args.output, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for source in sorted(root.rglob("*")):
            relative = source.relative_to(root)
            if source.is_file() and included(relative):
                archive.write(source, relative.as_posix())
                count += 1
    print(f"Packaged {count} files: {args.output.resolve()}")


if __name__ == "__main__":
    main()
