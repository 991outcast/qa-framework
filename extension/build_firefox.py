"""Сборка расширения для Firefox: python extension/build_firefox.py

Код у Chrome и Firefox общий; отличается только манифест (в Firefox боковая панель — sidebar_action,
фоновый скрипт — background.scripts). Скрипт копирует файлы расширения в папку extension-firefox рядом с
extension и кладёт туда manifest.firefox.json под именем manifest.json, а также делает архив
extension-firefox.zip (его можно подписать на addons.mozilla.org, чтобы расширение не пропадало после
перезапуска Firefox).
"""

from __future__ import annotations

import json
import shutil
import sys
import zipfile
from pathlib import Path

SRC = Path(__file__).resolve().parent
SKIP = {"manifest.json", "manifest.firefox.json", "build_firefox.py", "eval_cards.js"}


def build(out: Path | None = None) -> Path:
    out = out or SRC.parent / "extension-firefox"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    for f in SRC.iterdir():
        if f.is_file() and f.name not in SKIP and not f.name.startswith(".") and f.suffix != ".pyc":
            shutil.copy2(f, out / f.name)
    manifest = json.loads((SRC / "manifest.firefox.json").read_text(encoding="utf-8"))
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    with zipfile.ZipFile(out.with_suffix(".zip"), "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(out.iterdir()):
            zf.write(f, f.name)
    return out


if __name__ == "__main__":
    folder = build(Path(sys.argv[1]) if len(sys.argv) > 1 else None)
    print(f"Готово: {folder}\nFirefox → about:debugging → «Этот Firefox» → «Загрузить временное дополнение…» → "
          f"файл {folder / 'manifest.json'}")
