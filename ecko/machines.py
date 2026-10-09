"""Embroidery machine catalog.

Each brand reads a specific file format. Picking the machine decides:
  * which file format we write (and which alternates we offer),
  * which hoops are available (so we can warn before a design won't fit),
  * single- vs multi-needle behaviour (color-change time, sew-time estimate),
  * typical sewing speed.

Hoop sizes are the common sizes sold for each machine family. Owners can
always enter a custom hoop, because accessory hoops vary by model.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

FORMATS: dict[str, dict] = {
    "pes": {
        "label": "PES",
        "description": "Brother, Baby Lock, Bernette, Deco",
        "settings": {"version": 6},
    },
    "pec": {
        "label": "PEC",
        "description": "Older Brother machines and memory cards",
        "settings": {},
    },
    "dst": {
        "label": "DST",
        "description": "Tajima format, read by nearly every commercial machine",
        "settings": {},
    },
    "jef": {
        "label": "JEF",
        "description": "Janome, Elna, Kenmore",
        "settings": {"trims": True},
    },
    "exp": {
        "label": "EXP",
        "description": "Melco, Bernina",
        "settings": {},
    },
    "vp3": {
        "label": "VP3",
        "description": "Husqvarna Viking, Pfaff",
        "settings": {},
    },
    "xxx": {
        "label": "XXX",
        "description": "Singer",
        "settings": {},
    },
    "u01": {
        "label": "U01",
        "description": "Barudan",
        "settings": {},
    },
}


@dataclass
class Hoop:
    id: str
    name: str
    width_mm: float
    height_mm: float


@dataclass
class Model:
    id: str
    name: str
    hoops: list[Hoop]


@dataclass
class Brand:
    id: str
    name: str
    formats: list[str]  # first entry is the default
    needles: str  # "single" or "multi"
    stitches_per_minute: int
    models: list[Model] = field(default_factory=list)


def _h(id_: str, name: str, w: float, h: float) -> Hoop:
    return Hoop(id_, name, w, h)


# Shared hoop sets
_BROTHER_4X4 = [_h("4x4", '4" x 4" (100 x 100 mm)', 100, 100)]
_BROTHER_5X7 = _BROTHER_4X4 + [_h("5x7", '5" x 7" (130 x 180 mm)', 130, 180)]
_BROTHER_6X10 = _BROTHER_5X7 + [_h("6x10", '6" x 10" (160 x 260 mm)', 160, 260)]
_BROTHER_8X12 = _BROTHER_6X10 + [
    _h("8x8", '8" x 8" (200 x 200 mm)', 200, 200),
    _h("8x12", '8" x 12" (200 x 300 mm)', 200, 300),
]
_BROTHER_LUMINAIRE = _BROTHER_8X12 + [_h("9.5x14", '9.5" x 14" (240 x 360 mm)', 240, 360)]

_COMMERCIAL = [
    _h("cap", "Cap / hat front (60 x 140 mm)", 140, 60),
    _h("r12", "12 cm round (120 x 120 mm)", 120, 120),
    _h("r15", "15 cm round (150 x 150 mm)", 150, 150),
    _h("r18", "18 cm round (180 x 180 mm)", 180, 180),
    _h("r21", "21 cm round (210 x 210 mm)", 210, 210),
    _h("sq30", "30 cm square (300 x 300 mm)", 300, 300),
    _h("jacket", "Jacket back (360 x 360 mm)", 360, 360),
]

_JANOME = [
    _h("sq14", "SQ14 (140 x 140 mm)", 140, 140),
    _h("re20", "RE20 (170 x 200 mm)", 170, 200),
    _h("sq20", "SQ20 (200 x 200 mm)", 200, 200),
    _h("re28", "RE28 (200 x 280 mm)", 200, 280),
]

_HUSQVARNA = [
    _h("120", "120 x 120 mm", 120, 120),
    _h("240x150", "240 x 150 mm", 240, 150),
    _h("260x200", "260 x 200 mm", 260, 200),
    _h("360x200", "360 x 200 mm", 360, 200),
]

_BERNINA = [
    _h("small", "Small (40 x 72 mm)", 72, 40),
    _h("medium", "Medium (100 x 130 mm)", 100, 130),
    _h("oval", "Large oval (145 x 255 mm)", 145, 255),
    _h("maxi", "Maxi (210 x 400 mm)", 210, 400),
]

_SINGER = [
    _h("100", "100 x 100 mm", 100, 100),
    _h("260x150", "260 x 150 mm", 260, 150),
]

BRANDS: list[Brand] = [
    Brand("brother", "Brother", ["pes", "pec", "dst"], "single", 650, [
        Model("se600", "SE600 / SE630 / SE700", _BROTHER_4X4),
        Model("pe800", "PE800 / PE900 / SE1900 / SE2000", _BROTHER_5X7),
        Model("nq1700e", "NQ1700E / Innov-is 1250D / PE910L", _BROTHER_6X10),
        Model("stellaire", "Stellaire / Innov-is XJ1 / XE1", _BROTHER_8X12),
        Model("luminaire", "Luminaire XP / Dream Machine", _BROTHER_LUMINAIRE),
        Model("other", "Other Brother single-needle", _BROTHER_8X12),
    ]),
    Brand("brother-pr", "Brother PR (multi-needle)", ["pes", "dst"], "multi", 1000, [
        Model("pr680w", "PR680W / PR1055X / PR1X", _COMMERCIAL),
    ]),
    Brand("babylock", "Baby Lock", ["pes", "dst"], "single", 650, [
        Model("alliance", "Alliance / Flare / Pathfinder", _BROTHER_6X10),
        Model("destiny", "Destiny / Solaris / Altair", _BROTHER_8X12),
        Model("valiant", "Valiant / Enterprise (multi-needle)", _COMMERCIAL),
    ]),
    Brand("janome", "Janome / Elna", ["jef", "dst", "exp"], "single", 700, [
        Model("mc400e", "Memory Craft 400E / 500E / 550E", _JANOME),
        Model("skyline", "Skyline S9 / Continental M17", _JANOME),
        Model("mb", "MB-4S / MB-7 (multi-needle)", _JANOME[:3]),
    ]),
    Brand("bernina", "Bernina", ["exp", "dst"], "single", 700, [
        Model("b500e", "500 / 700 / 735 / 790 series", _BERNINA),
        Model("b880", "880 / 990", _BERNINA),
        Model("e16", "E 16 (multi-needle)", _COMMERCIAL),
    ]),
    Brand("husqvarna", "Husqvarna Viking", ["vp3", "dst"], "single", 700, [
        Model("designer", "Designer Epic / Ruby / Topaz / Jade", _HUSQVARNA),
    ]),
    Brand("pfaff", "Pfaff", ["vp3", "dst"], "single", 700, [
        Model("creative", "Creative Icon / Ambition / 4.5", _HUSQVARNA),
    ]),
    Brand("singer", "Singer", ["xxx", "dst"], "single", 600, [
        Model("legacy", "Legacy SE300 / SE9180 / SE9185", _SINGER),
        Model("futura", "Futura series", _SINGER),
    ]),
    Brand("ricoma", "Ricoma", ["dst"], "multi", 1000, [
        Model("em1010", "EM-1010 / MT-1501 / CHS series", _COMMERCIAL),
    ]),
    Brand("tajima", "Tajima", ["dst"], "multi", 1000, [
        Model("tajima", "All Tajima models", _COMMERCIAL),
    ]),
    Brand("barudan", "Barudan", ["dst", "u01"], "multi", 1000, [
        Model("barudan", "All Barudan models", _COMMERCIAL),
    ]),
    Brand("melco", "Melco", ["dst", "exp"], "multi", 1000, [
        Model("melco", "Summit / EMT16X / Amaya", _COMMERCIAL),
    ]),
    Brand("swf", "SWF", ["dst"], "multi", 1000, [
        Model("swf", "All SWF models", _COMMERCIAL),
    ]),
    Brand("happy", "Happy Japan", ["dst"], "multi", 1000, [
        Model("happy", "All Happy models", _COMMERCIAL),
    ]),
    Brand("other", "Other / not listed", list(FORMATS), "single", 650, [
        Model("generic", "Generic machine", _BROTHER_8X12 + _COMMERCIAL[1:]),
    ]),
]

_BRANDS_BY_ID = {b.id: b for b in BRANDS}


def get_brand(brand_id: str) -> Brand:
    try:
        return _BRANDS_BY_ID[brand_id]
    except KeyError as exc:
        raise ValueError(f"Unknown machine brand: {brand_id}") from exc


def get_model(brand: Brand, model_id: str | None) -> Model:
    for m in brand.models:
        if m.id == model_id:
            return m
    return brand.models[0]


def catalog() -> dict:
    return {
        "formats": {k: {"label": v["label"], "description": v["description"]} for k, v in FORMATS.items()},
        "brands": [asdict(b) for b in BRANDS],
    }
