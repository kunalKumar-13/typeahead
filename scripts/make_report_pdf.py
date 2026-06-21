"""Render docs/REPORT.md -> docs/REPORT.pdf.

Markdown -> styled HTML (tables, fenced code, syntax highlight) -> PDF via
headless Chrome (no extra system PDF libraries needed on macOS).
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
MD = ROOT / "docs" / "REPORT.md"
PDF = ROOT / "docs" / "REPORT.pdf"

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]

CSS = """
@page { size: A4; margin: 16mm 14mm; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
       font-size: 10.5pt; line-height: 1.45; color: #1a1a1a; }
h1 { font-size: 20pt; border-bottom: 2px solid #333; padding-bottom: 4px; }
h2 { font-size: 14pt; margin-top: 20px; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
h3 { font-size: 11.5pt; margin-top: 14px; }
code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 9pt;
       background: #f2f3f5; padding: 1px 4px; border-radius: 3px; }
pre { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px;
      padding: 8px 10px; overflow: visible; }
pre code { background: none; padding: 0; font-size: 7.4pt; line-height: 1.2;
           white-space: pre; }
table { border-collapse: collapse; width: 100%; font-size: 8.8pt; margin: 8px 0; }
th, td { border: 1px solid #cfd4da; padding: 4px 7px; text-align: left;
         vertical-align: top; }
th { background: #eef1f4; }
tr:nth-child(even) td { background: #fafbfc; }
blockquote { border-left: 3px solid #b8c0c8; margin: 8px 0; padding: 2px 12px;
             color: #555; background: #f7f9fb; }
strong { color: #111; }
a { color: #1a5fb4; text-decoration: none; }
"""


def find_chrome() -> str:
    for c in CHROME_CANDIDATES:
        if c and Path(c).exists():
            return c
    raise SystemExit("No Chrome/Chromium found for PDF rendering.")


def main() -> None:
    html_body = markdown.markdown(
        MD.read_text(),
        extensions=["tables", "fenced_code", "codehilite", "toc"],
        extension_configs={"codehilite": {"noclasses": True, "guess_lang": False}},
    )
    html = f"<!doctype html><html><head><meta charset='utf-8'><style>{CSS}</style>" \
           f"</head><body>{html_body}</body></html>"

    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(html)
        html_path = f.name

    chrome = find_chrome()
    PDF.parent.mkdir(exist_ok=True)
    cmd = [
        chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--no-pdf-header-footer", f"--print-to-pdf={PDF}", f"file://{html_path}",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if not PDF.exists() or PDF.stat().st_size == 0:
        # older Chrome flag fallback
        cmd[cmd.index("--headless=new")] = "--headless"
        res = subprocess.run(cmd, capture_output=True, text=True)
    if not PDF.exists() or PDF.stat().st_size == 0:
        sys.stderr.write(res.stderr)
        raise SystemExit("PDF generation failed.")
    print(f"wrote {PDF} ({PDF.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
