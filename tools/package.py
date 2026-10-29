"""Build a reproducible unpacked-extension ZIP with an explicit file allowlist."""

import argparse
import hashlib
import json
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", action="store_true", help="Include tests, tools and CI for a GitHub source release")
args = parser.parse_args()
# Refuse credentials before creating a temporary ZIP or replacing an old one.
subprocess.run(["node", str(ROOT / "tools/check-secrets.mjs")], cwd=ROOT, check=True)
manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
files = [
    ROOT / "manifest.json",
    ROOT / "README.md",
    ROOT / "CHANGELOG.md",
    ROOT / "CONTRIBUTING.md",
    ROOT / "SECURITY.md",
    ROOT / "docs/README.en.md",
    ROOT / "docs/PRIVACY.md",
    ROOT / "docs/VERIFICATION.md",
    ROOT / "docs/CODE_REVIEW.md",
    ROOT / "docs/VOICE_QUALITY.md",
    ROOT / "assets/cover.svg",
]
files.extend((ROOT / "docs/screenshots").glob("*.png"))
for directory, suffixes in [
    ("src", {".js", ".html", ".css"}),
    ("assets/icons", {".svg", ".png"}),
]:
    files.extend(
        p for p in (ROOT / directory).rglob("*") if p.is_file() and p.suffix in suffixes
    )
if args.source:
    files.extend(ROOT / name for name in (".gitignore", ".gitattributes", "requirements-dev.txt"))
    for directory, suffixes in [
        ("tools", {".py", ".mjs"}),
        ("tests", {".py", ".js", ".mjs"}),
        (".github", {".yml", ".yaml", ".md"}),
    ]:
        files.extend(p for p in (ROOT / directory).rglob("*") if p.is_file() and p.suffix in suffixes)
    files.append(ROOT / "tests/fixtures/demo.vtt")
files = sorted(set(files))
for release_file in files:
    if release_file.is_symlink() or not release_file.resolve().is_relative_to(ROOT):
        raise ValueError("Release files must stay inside the project without symlinks")
# Check the exact archive inputs as well: an ignored generated asset can still
# be selected by the packaging allowlist and must not bypass the credential gate.
subprocess.run(
    ["node", str(ROOT / "tools/check-secrets.mjs"), "--paths-stdin"],
    cwd=ROOT,
    input="\0".join(p.relative_to(ROOT).as_posix() for p in files),
    text=True,
    encoding="utf-8",
    check=True,
)
destination = ROOT / "dist"
destination.mkdir(exist_ok=True)
kind = "-source" if args.source else ""
archive = destination / f"neirotranslate-{manifest['version']}{kind}.zip"
with tempfile.NamedTemporaryFile(dir=destination, suffix=".zip", delete=False) as temp:
    temporary = Path(temp.name)
try:
    with zipfile.ZipFile(
        temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as zipped:
        for path in sorted(files):
            info = zipfile.ZipInfo(path.relative_to(ROOT).as_posix())
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            zipped.writestr(info, path.read_bytes())
    with zipfile.ZipFile(temporary) as zipped:
        if zipped.testzip() is not None:
            raise ValueError("Archive integrity verification failed")
        expected = {path.relative_to(ROOT).as_posix() for path in files}
        if set(zipped.namelist()) != expected or len(zipped.namelist()) != len(files):
            raise ValueError("Archive has missing or duplicate entries")
    # Keep a previous release intact if building or verification fails.
    temporary.replace(archive)
finally:
    temporary.unlink(missing_ok=True)
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(".zip.sha256").write_text(
    f"{checksum}  {archive.name}\n", encoding="ascii"
)
print(
    f"{archive}\n{len(files)} files; {archive.stat().st_size:,} bytes\nSHA256 {checksum}"
)
