"""Bygger den statiske versjonen til GitHub Pages i site/.

Kopierer static/, skriver om absolutte stier til relative (Pages ligger under
/nordvakt-osint/) og slår på statisk modus i forsiden og appen.

    python -m scripts.build_site
"""

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "static"
SITE = ROOT / "site"
FLAG = "<head>\n  <script>window.NORDVAKT_STATIC = true;</script>"


def convert(html: str) -> str:
    html = html.replace("<head>", FLAG, 1)
    html = html.replace('"/static/', '"static/')
    html = html.replace('href="/app#', 'href="app.html#').replace('href="/app"', 'href="app.html"')
    html = html.replace('href="/"', 'href="./"')
    return html


def main() -> None:
    SITE.mkdir(exist_ok=True)
    shutil.copytree(STATIC, SITE / "static", dirs_exist_ok=True, ignore=shutil.ignore_patterns("*.html"))
    (SITE / "index.html").write_text(convert((STATIC / "home.html").read_text(encoding="utf-8")), encoding="utf-8")
    (SITE / "app.html").write_text(convert((STATIC / "index.html").read_text(encoding="utf-8")), encoding="utf-8")
    (SITE / ".nojekyll").write_text("")


if __name__ == "__main__":
    main()
