"""Convierte data/sucursales_banamex.csv a data/sucursales.json (formato compacto para la página).

Uso: python3 scripts/csv_a_json.py
"""
import csv
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent / "huracanes-sucursales" / "data"
CAMPOS = ["numero", "nombre", "direccion", "complemento", "estado", "telefono",
          "horario_lun_vie", "sabado", "servicios"]


def main():
    filas = []
    with open(BASE / "sucursales_banamex.csv", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            try:
                lat, lon = float(r["latitud"]), float(r["longitud"])
            except (TypeError, ValueError):
                continue
            filas.append([r[c].strip() for c in CAMPOS] + [round(lat, 6), round(lon, 6)])
    salida = {"campos": CAMPOS + ["lat", "lon"], "sucursales": filas}
    (BASE / "sucursales.json").write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(filas)} sucursales escritas en {BASE / 'sucursales.json'}")


if __name__ == "__main__":
    main()
