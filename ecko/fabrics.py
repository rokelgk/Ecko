"""Fabric presets.

Auto-digitizers are criticised for treating every garment the same. The
fabric decides density, pull compensation, underlay and how wide a satin
column can safely be, so every digitize call starts from one of these.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Fabric:
    id: str
    name: str
    fill_spacing_mm: float  # distance between fill rows
    satin_spacing_mm: float  # peak-to-peak satin spacing
    pull_comp_mm: float  # how far shapes are widened to fight fabric pull
    underlay: str  # "light", "medium", "heavy"
    max_satin_mm: float  # wider columns become fill (long satin snags)
    fill_stitch_mm: float  # tatami stitch length
    tip: str
    center_out: bool = False  # sew from the centre outwards (caps)


FABRICS: list[Fabric] = [
    Fabric("woven", "Woven / twill / denim", 0.40, 0.40, 0.20, "light", 7.0, 4.0,
           "Stable fabric. Use one layer of tear-away stabilizer."),
    Fabric("tshirt", "T-shirt / jersey knit", 0.45, 0.42, 0.30, "medium", 6.5, 3.5,
           "Knits stretch. Use cut-away stabilizer and don't stretch the shirt in the hoop."),
    Fabric("polo", "Polo / piqué knit", 0.42, 0.40, 0.35, "medium", 6.5, 3.5,
           "Use cut-away stabilizer; the extra underlay keeps the stitches above the texture."),
    Fabric("fleece", "Fleece / sweatshirt", 0.40, 0.40, 0.35, "heavy", 7.0, 3.5,
           "Add a water-soluble topper so stitches don't sink into the pile."),
    Fabric("towel", "Towel / terry / plush", 0.38, 0.38, 0.35, "heavy", 6.5, 3.5,
           "Always use a water-soluble topper on terry, or the loops poke through."),
    Fabric("cap", "Caps / hats", 0.40, 0.40, 0.35, "medium", 6.0, 3.5,
           "Sewn from the centre out and bottom up to stop the crown from shifting.", True),
    Fabric("canvas", "Canvas / bags / heavy cotton", 0.40, 0.40, 0.20, "light", 7.0, 4.0,
           "Tear-away stabilizer is enough for heavy canvas."),
    Fabric("leather", "Leather / vinyl", 0.55, 0.50, 0.15, "light", 6.0, 4.5,
           "Every needle hole is permanent, so this preset uses fewer stitches. Test on a scrap first."),
]

_BY_ID = {f.id: f for f in FABRICS}


def get_fabric(fabric_id: str) -> Fabric:
    try:
        return _BY_ID[fabric_id]
    except KeyError as exc:
        raise ValueError(f"Unknown fabric: {fabric_id}") from exc


def catalog() -> list[dict]:
    return [asdict(f) for f in FABRICS]
