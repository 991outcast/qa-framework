"""T-Work (twork.tbank.ru) — площадка по умолчанию: её значения записаны прямо в config.py."""

from adapters import PlatformAdapter


class TWorkAdapter(PlatformAdapter):
    key = "twork"
    title = "T-Work"
    settings = {
        # страница «Клекс» без заданий: модель сама нажала «Перейти в обучение» (лог 19.10) — куда идти
        # дальше, выбирает человек
        "EXTRA_DENY_SUBSTRINGS": ("перейти в обучение",),
    }
