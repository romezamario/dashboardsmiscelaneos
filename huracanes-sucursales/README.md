# Sucursales vs huracanes

Página estática que cruza las 1,051 sucursales Banamex (`data/sucursales_banamex.csv`) con las tormentas
tropicales activas y ordena las sucursales por exposición.

## Fuentes de tormentas

1. **NOAA National Hurricane Center**, servicio ArcGIS
   `mapservices.weather.noaa.gov/.../NHC_tropical_weather/MapServer`: cono de pronóstico, trayectoria,
   puntos de pronóstico (con viento máximo y fecha) y trayectoria pasada. Cubre Atlántico (Golfo y Caribe)
   y Pacífico oriental.
2. **GDACS** como respaldo si NOAA no responde.
3. **Ejemplos históricos** (Otis 2023, Beryl 2024; trayectorias aproximadas), **simulación** con clic en el
   mapa y **carga de GeoJSON** propio (polígonos = cono, líneas = trayectoria, puntos con `MAXWIND` en nudos).

Los datos se consultan desde el navegador y se refrescan cada 30 minutos. zoom.earth no tiene API pública,
así que se usa como enlace: el botón de la cabecera y el de cada sucursal abren zoom.earth centrado en ese punto.

## Índice de exposición (0–100)

`índice = 100 × factor_viento × cercanía`

- `factor_viento = viento / 140 kt`, acotado entre 0.25 y 1, con el viento del punto de pronóstico más cercano.
- `cercanía = e^(−distancia / 120 km)`, con la distancia a la trayectoria; si la sucursal queda dentro del
  cono, la cercanía es al menos 0.6.
- Solo cuentan sucursales dentro del cono o a menos del *radio de influencia* (250 km por defecto, ajustable).
- Niveles: alta ≥ 55, media ≥ 25, baja > 0.

Es una referencia operativa, no un pronóstico oficial.

## Actualizar las sucursales

Reemplaza `data/sucursales_banamex.csv` (mismas columnas) y ejecuta:

```bash
python3 scripts/csv_a_json.py
```

## Probar

`?ejemplo=otis` o `?ejemplo=beryl` en la URL carga un ejemplo al abrir la página.
