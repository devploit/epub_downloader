"""Package the unpacked extension without development dependencies."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
output = root / "dist" / "epub-downloader-extension.zip"
output.parent.mkdir(exist_ok=True)
# Keep local caches, editor files, and test artifacts out of shared packages.
extension_files = (
    "manifest.json", "background.js", "app.html", "app.css", "app.js",
    "browser.js", "core.js", "zip.js", "README.md",
    "icons/logo.svg", "icons/icon-16.png", "icons/icon-32.png",
    "icons/icon-48.png", "icons/icon-128.png",
)
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for name in extension_files:
        archive.write(root / "extension" / name, name)
    archive.write(root / "LICENSE", "LICENSE")
print(output)
