#!/usr/bin/env python3
"""Generate lunad place-search data files.

Inputs (download first):
  cities15000.txt   https://download.geonames.org/export/dump/cities15000.zip
  admin1CodesASCII.txt  https://download.geonames.org/export/dump/admin1CodesASCII.txt
  countryInfo.txt   https://download.geonames.org/export/dump/countryInfo.txt
  ne_countries.geojson  Natural Earth 110m admin_0_countries geojson

Outputs (under OUT_DIR):
  cities.tsv     lat lon pop name ascii region country
  regions.tsv    iso name ascii           (admin1 units)
  countries.txt  name|minLat|maxLat|minLon|maxLon|ring;ring...
"""
import json, sys, unicodedata, os

SRC = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
os.makedirs(OUT, exist_ok=True)

def load_country_names():
    m = {}
    for line in open(f"{SRC}/countryInfo.txt"):
        if line.startswith("#") or not line.strip():
            continue
        f = line.rstrip("\n").split("\t")
        m[f[0]] = f[4]
    return m

def load_admin1():
    # code "US.OR" -> (name, ascii)
    m = {}
    rows = []
    for line in open(f"{SRC}/admin1CodesASCII.txt"):
        f = line.rstrip("\n").split("\t")
        if len(f) < 4:
            continue
        code, name, ascii_ = f[0], f[1], f[2]
        m[code] = (name, ascii_)
        iso = code.split(".")[0]
        rows.append((iso, name, ascii_))
    return m, rows

def main():
    countries = load_country_names()
    admin1, admin1_rows = load_admin1()

    seen_region_keys = set()
    with open(f"{OUT}/regions.tsv", "w") as w:
        for iso, name, ascii_ in admin1_rows:
            w.write(f"{iso}\t{name}\t{ascii_}\n")

    n_cities = 0
    with open(f"{OUT}/cities.tsv", "w") as w:
        for line in open(f"{SRC}/cities15000.txt"):
            f = line.rstrip("\n").split("\t")
            if len(f) < 15:
                continue
            name, ascii_, lat, lon = f[1], f[2], f[4], f[5]
            cc, a1, pop = f[8], f[10], f[14]
            # Skip sections of populated places (Paris arrondissements,
            # city districts) and abandoned/destroyed settlements.
            if f[7] in ("PPLX", "PPLQ", "PPLH", "PPLW"):
                continue
            if not name or not lat or not lon:
                continue
            region = admin1.get(f"{cc}.{a1}", ("", ""))[0] if a1 else ""
            country = countries.get(cc, cc)
            if ascii_ == name: ascii_ = ""
            w.write(f"{lat}\t{lon}\t{pop}\t{name}\t{ascii_}\t{region}\t{country}\n")
            n_cities += 1

    fix_iso = {"Norway": "NO", "France": "FR", "Kosovo": "XK",
               "N. Cyprus": "CY", "Somaliland": "SO"}
    n_poly = 0
    with open(f"{OUT}/countries.txt", "w") as w:
        for feat in json.load(open(f"{SRC}/ne_countries.geojson"))["features"]:
            p = feat["properties"]
            name = p.get("NAME") or p.get("NAME_LONG")
            iso = p.get("ISO_A2")
            if iso in (None, "-99"):
                iso = fix_iso.get(name, "")
            # Canonical name = GeoNames countryInfo (matches cities.tsv's
            # country column); fall back to the Natural Earth name.
            name = countries.get(iso, name)
            geom = feat["geometry"]
            polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
            rings_out = []
            minlat, maxlat, minlon, maxlon = 999, -999, 999, -999
            for poly in polys:
                for ring in poly:  # exterior + holes
                    pts = []
                    for x, y in ring:
                        x, y = round(x, 2), round(y, 2)
                        if x < minlon: minlon = x
                        if x > maxlon: maxlon = x
                        if y < minlat: minlat = y
                        if y > maxlat: maxlat = y
                        pts.append(f"{y:g},{x:g}")
                    # drop degenerate rings
                    if len(pts) >= 4:
                        rings_out.append(" ".join(pts))
            if not rings_out or not name:
                continue
            w.write(f"{name}|{iso}|{minlat:g}|{maxlat:g}|{minlon:g}|{maxlon:g}|{';'.join(rings_out)}\n")
            n_poly += 1

    print(f"cities={n_cities} regions={len(admin1_rows)} countries={n_poly}")
    for fn in ["cities.tsv", "regions.tsv", "countries.txt"]:
        print(fn, os.path.getsize(f"{OUT}/{fn}"))

main()
