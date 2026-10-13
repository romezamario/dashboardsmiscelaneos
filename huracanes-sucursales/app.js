/* Sucursales Banamex vs huracanes activos.
 * Fuentes: NOAA NHC (servicio ArcGIS, con CORS) y GDACS como respaldo.
 * Todo corre en el navegador; no hay backend. */
(function () {
  "use strict";

  const NOAA_MAPSERVER = "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer";
  const GDACS_EVENTS = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtypes=TC";
  const GDACS_GEOMETRY = "https://www.gdacs.org/gdacsapi/api/polygons/getgeometry";
  const REFRESCO_MS = 30 * 60 * 1000;
  const KM_DECAIMIENTO = 120; // a esta distancia de la trayectoria la cercanía vale ~37 %

  const COLORES = { alta: "#d7263d", media: "#f08a24", baja: "#e9c400", sin: "#9aa5b1" };
  const COLOR_TORMENTA = ["#c05cff", "#00b3c7", "#ff4fa3", "#3fbf5f", "#ff7a00", "#4f7cff"];

  const estado = {
    sucursales: [],
    tormentas: [],        // {id, nombre, fuente, cono:[GeoJSON geom], trayectoria:[[lat,lon],...][], puntos:[{lat,lon,viento,etiqueta}], circulo?:{lat,lon,radioKm}}
    resultados: [],
    radioKm: 250,
    simulando: false,
    contadorSim: 0,
  };

  // ---------- Mapa ----------
  const mapa = L.map("mapa", { preferCanvas: true, worldCopyJump: true }).setView([21, -97], 5);
  const hoy = new Date();
  const ayer = new Date(hoy.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const bases = {
    "Mapa claro": L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap, &copy; CARTO",
    }),
    "Mapa oscuro": L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap, &copy; CARTO",
    }),
    "Satélite (Esri)": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, attribution: "Imágenes &copy; Esri",
    }),
  };
  const nubes = L.tileLayer(
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${ayer}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
    { maxNativeZoom: 9, maxZoom: 19, opacity: 0.75, attribution: "NASA GIBS / VIIRS" }
  );
  bases["Mapa claro"].addTo(mapa);
  const capaTormentas = L.layerGroup().addTo(mapa);
  const capaSucursales = L.layerGroup().addTo(mapa);
  L.control.layers(bases, { [`Nubes satélite (VIIRS, ${ayer})`]: nubes, "Tormentas": capaTormentas, "Sucursales": capaSucursales }, { position: "topright" }).addTo(mapa);
  L.control.scale({ imperial: false }).addTo(mapa);

  // ---------- Utilidades ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const R_TIERRA = 6371;
  const rad = (g) => (g * Math.PI) / 180;

  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_TIERRA * Math.asin(Math.sqrt(a));
  }

  // Distancia punto-segmento con proyección equirectangular local (suficiente a escala regional).
  function distSegmento(lat, lon, a, b) {
    const k = Math.cos(rad(lat));
    const px = lon * k, py = lat;
    const ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qLat = ay + t * dy, qLon = (ax + t * dx) / k;
    return haversine(lat, lon, qLat, qLon);
  }

  function puntoEnAnillo(lon, lat, anillo) {
    let dentro = false;
    for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
      const xi = anillo[i][0], yi = anillo[i][1], xj = anillo[j][0], yj = anillo[j][1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
  }

  function puntoEnGeometria(lat, lon, geom) {
    if (!geom) return false;
    const poligonos = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    return poligonos.some((p) => p.length && puntoEnAnillo(lon, lat, p[0]) && !p.slice(1).some((h) => puntoEnAnillo(lon, lat, h)));
  }

  function categoria(kt) {
    if (kt == null || isNaN(kt)) return { corta: "?", larga: "Sin dato", color: COLORES.sin };
    if (kt >= 137) return { corta: "C5", larga: "Huracán cat. 5", color: "#8b0000" };
    if (kt >= 113) return { corta: "C4", larga: "Huracán cat. 4", color: "#c4002b" };
    if (kt >= 96) return { corta: "C3", larga: "Huracán cat. 3", color: "#e8431b" };
    if (kt >= 83) return { corta: "C2", larga: "Huracán cat. 2", color: "#f27d1f" };
    if (kt >= 64) return { corta: "C1", larga: "Huracán cat. 1", color: "#f5b324" };
    if (kt >= 34) return { corta: "TT", larga: "Tormenta tropical", color: "#2b9bd8" };
    return { corta: "DT", larga: "Depresión tropical", color: "#5aa0a8" };
  }
  const ktAKmh = (kt) => Math.round(kt * 1.852);

  function tomar(props, claves) {
    for (const k of claves) {
      for (const pk of Object.keys(props || {})) if (pk.toLowerCase() === k.toLowerCase() && props[pk] !== null && props[pk] !== "") return props[pk];
    }
    return undefined;
  }

  async function getJSON(url, ms = 20000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function enParalelo(items, limite, fn) {
    const salida = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limite, items.length) }, async () => {
      while (i < items.length) {
        const n = i++;
        try { salida[n] = await fn(items[n]); } catch (e) { salida[n] = null; }
      }
    }));
    return salida;
  }

  // Esri JSON -> GeoJSON (por si el servidor no acepta f=geojson).
  function esriAGeoJSON(esri) {
    return {
      type: "FeatureCollection",
      features: (esri.features || []).map((f) => {
        const g = f.geometry || {};
        let geometry = null;
        if (g.rings) geometry = { type: "Polygon", coordinates: g.rings };
        else if (g.paths) geometry = { type: "MultiLineString", coordinates: g.paths };
        else if (g.x != null) geometry = { type: "Point", coordinates: [g.x, g.y] };
        return { type: "Feature", properties: f.attributes || {}, geometry };
      }),
    };
  }

  // ---------- Normalización de tormentas ----------
  function nuevaTormenta(id, nombre, fuente) {
    return { id, nombre, fuente, cono: [], trayectoria: [], puntos: [], pasado: [], visible: true };
  }

  // Reparte un FeatureCollection en cono / trayectoria / puntos según su geometría.
  function agregarFeatures(t, fc, tipo) {
    for (const f of (fc && fc.features) || []) {
      const g = f.geometry;
      if (!g) continue;
      const p = f.properties || {};
      if (g.type === "Polygon" || g.type === "MultiPolygon") {
        if (tipo !== "pasado") t.cono.push(g);
      } else if (g.type === "LineString" || g.type === "MultiLineString") {
        const lineas = g.type === "LineString" ? [g.coordinates] : g.coordinates;
        for (const l of lineas) (tipo === "pasado" ? t.pasado : t.trayectoria).push(l.map((c) => [c[1], c[0]]));
      } else if (g.type === "Point" || g.type === "MultiPoint") {
        const pts = g.type === "Point" ? [g.coordinates] : g.coordinates;
        for (const c of pts) {
          let viento = Number(tomar(p, ["MAXWIND", "INTENSITY", "wind", "viento", "maxwind_kt"]));
          const kmh = Number(tomar(p, ["wind_kmh", "viento_kmh"]));
          if (isNaN(viento) && !isNaN(kmh)) viento = kmh / 1.852;
          t.puntos.push({
            lat: c[1], lon: c[0],
            viento: isNaN(viento) ? null : viento,
            etiqueta: tomar(p, ["FLDATELBL", "DATELBL", "ADVDATE", "fecha", "date", "trackdate"]) || "",
            pasado: tipo === "pasado",
          });
        }
      }
    }
  }

  async function cargarNOAA() {
    const info = await getJSON(`${NOAA_MAPSERVER}?f=json`);
    const capas = info.layers || [];
    const porId = Object.fromEntries(capas.map((c) => [c.id, c]));
    const tipos = [
      [/forecast\s*cone/i, "cono"],
      [/forecast\s*track/i, "trayectoria"],
      [/forecast\s*points?/i, "puntos"],
      [/past\s*track/i, "pasado"],
      [/past\s*points?/i, "pasado"],
    ];
    const consultas = [];
    for (const c of capas) {
      if (c.subLayerIds && c.subLayerIds.length) continue;
      const tipo = (tipos.find(([re]) => re.test(c.name)) || [])[1];
      if (!tipo || /prob|arrival/i.test(c.name)) continue;
      const grupo = c.parentLayerId != null && porId[c.parentLayerId] ? porId[c.parentLayerId].name : c.name.split(/\s+/)[0];
      consultas.push({ id: c.id, tipo, grupo });
    }
    if (!consultas.length) throw new Error("El servicio NOAA no expuso capas de pronóstico");

    const resultados = await enParalelo(consultas, 8, async (q) => {
      const base = `${NOAA_MAPSERVER}/${q.id}/query?where=1%3D1&outFields=*&outSR=4326&returnGeometry=true`;
      let fc;
      try { fc = await getJSON(`${base}&f=geojson`); } catch (e) { fc = null; }
      if (!fc || !fc.features) fc = esriAGeoJSON(await getJSON(`${base}&f=json`));
      return { q, fc };
    });

    const mapaT = new Map();
    for (const r of resultados) {
      if (!r || !r.fc.features || !r.fc.features.length) continue;
      for (const f of r.fc.features) {
        const p = f.properties || {};
        const nombre = tomar(p, ["STORMNAME", "STORMNAM", "NAME"]) || r.q.grupo;
        const id = `noaa-${r.q.grupo}`;
        if (!mapaT.has(id)) mapaT.set(id, nuevaTormenta(id, nombre, "NOAA NHC"));
        const t = mapaT.get(id);
        if (nombre && t.nombre === r.q.grupo) t.nombre = nombre;
        const tipoT = tomar(p, ["STORMTYPE", "TCDVLP"]);
        if (tipoT && !t.tipo) t.tipo = tipoT;
        const adv = tomar(p, ["ADVDATE", "ADVISNUM"]);
        if (adv && !t.aviso) t.aviso = adv;
        agregarFeatures(t, { features: [f] }, r.q.tipo);
      }
    }
    return [...mapaT.values()].filter((t) => t.cono.length || t.trayectoria.length || t.puntos.length);
  }

  async function cargarGDACS() {
    const eventos = await getJSON(GDACS_EVENTS);
    const activos = (eventos.features || []).filter((f) => {
      const p = f.properties || {};
      const c = f.geometry && f.geometry.coordinates;
      const actual = String(p.iscurrent).toLowerCase() === "true";
      // Solo tormentas en el entorno de México (Pacífico oriental, Golfo y Caribe).
      return actual && c && c[0] > -140 && c[0] < -50 && c[1] > 0 && c[1] < 40;
    });
    const tormentas = await enParalelo(activos, 4, async (f) => {
      const p = f.properties;
      const t = nuevaTormenta(`gdacs-${p.eventid}`, p.eventname || p.name || `TC ${p.eventid}`, "GDACS");
      const sev = p.severitydata || {};
      t.tipo = sev.severitytext || "";
      t.vientoGlobal = sev.severityunit === "km/h" && sev.severity ? sev.severity / 1.852 : null;
      const geo = await getJSON(`${GDACS_GEOMETRY}?eventtype=TC&eventid=${p.eventid}&episodeid=${p.episodeid}`);
      // GDACS mezcla puntos de trayectoria (con fecha) y buffers de viento; los buffers sirven como "cono".
      agregarFeatures(t, geo, "trayectoria");
      if (!t.puntos.length && f.geometry) t.puntos.push({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], viento: t.vientoGlobal, etiqueta: "" });
      if (t.vientoGlobal) t.puntos.forEach((pt) => { if (pt.viento == null) pt.viento = t.vientoGlobal; });
      if (!t.trayectoria.length && t.puntos.length > 1) t.trayectoria.push(t.puntos.map((pt) => [pt.lat, pt.lon]));
      return t;
    });
    return tormentas.filter(Boolean);
  }

  // ---------- Ejemplos históricos (trayectorias aproximadas, solo demostración) ----------
  const EJEMPLOS = {
    otis: {
      nombre: "Otis (oct 2023, aprox.)",
      puntos: [
        [12.4, -98.0, 35, "22 oct"], [13.3, -98.6, 45, "23 oct 00Z"], [14.3, -99.0, 60, "24 oct 00Z"],
        [15.2, -99.4, 115, "24 oct 18Z"], [16.4, -99.8, 145, "25 oct 03Z"], [16.8, -99.9, 145, "25 oct 06Z (tierra, Acapulco)"],
        [17.4, -100.2, 90, "25 oct 12Z"], [17.9, -100.6, 40, "25 oct 18Z"],
      ],
      radioConoKm: [40, 50, 60, 70, 80, 85, 95, 110],
    },
    beryl: {
      nombre: "Beryl (jul 2024, aprox.)",
      puntos: [
        [17.4, -80.8, 120, "3 jul 18Z"], [18.4, -83.4, 110, "4 jul 06Z"], [19.4, -85.6, 95, "4 jul 18Z"],
        [20.3, -87.5, 95, "5 jul 10Z (tierra, Tulum)"], [21.2, -89.3, 55, "5 jul 18Z"], [22.6, -91.5, 50, "6 jul 06Z"],
        [24.5, -93.6, 60, "7 jul 00Z"], [26.6, -95.4, 70, "7 jul 18Z"], [28.6, -96.0, 70, "8 jul 09Z"],
      ],
      radioConoKm: [50, 60, 70, 80, 90, 100, 115, 130, 145],
    },
  };

  // Cono aproximado: contorno único que rodea la trayectoria con un radio que crece en cada punto.
  function conoDesdePuntos(puntos, radios) {
    const n = puntos.length;
    const desplazar = (lat, lon, rumbo, km) => {
      const d = (km / R_TIERRA) * (180 / Math.PI);
      return [lon + (d * Math.sin(rumbo)) / Math.cos(rad(lat)), lat + d * Math.cos(rumbo)];
    };
    const rumbo = (a, b) => Math.atan2((b[1] - a[1]) * Math.cos(rad((a[0] + b[0]) / 2)), b[0] - a[0]);
    const rumbos = puntos.map((_, i) => rumbo(puntos[Math.max(0, i - 1)], puntos[Math.min(n - 1, i + 1)]));
    const izq = [], der = [];
    puntos.forEach(([lat, lon], i) => {
      izq.push(desplazar(lat, lon, rumbos[i] - Math.PI / 2, radios[i]));
      der.push(desplazar(lat, lon, rumbos[i] + Math.PI / 2, radios[i]));
    });
    const arco = (i, desde, hasta) => {
      const salida = [];
      for (let k = 1; k < 12; k++) salida.push(desplazar(puntos[i][0], puntos[i][1], desde + ((hasta - desde) * k) / 12, radios[i]));
      return salida;
    };
    const fin = arco(n - 1, rumbos[n - 1] - Math.PI / 2, rumbos[n - 1] + Math.PI / 2);
    const inicio = arco(0, rumbos[0] + Math.PI / 2, rumbos[0] + (3 * Math.PI) / 2);
    const anillo = izq.concat(fin, der.reverse(), inicio);
    anillo.push(anillo[0]);
    return { type: "Polygon", coordinates: [anillo] };
  }

  function tormentaEjemplo(clave) {
    const e = EJEMPLOS[clave];
    const t = nuevaTormenta(`ejemplo-${clave}`, e.nombre, "Ejemplo histórico");
    t.puntos = e.puntos.map(([lat, lon, viento, etiqueta]) => ({ lat, lon, viento, etiqueta }));
    t.trayectoria = [e.puntos.map(([lat, lon]) => [lat, lon])];
    t.cono = [conoDesdePuntos(e.puntos, e.radioConoKm)];
    return t;
  }

  function tormentaSimulada(lat, lon, viento, radioKm) {
    estado.contadorSim += 1;
    const t = nuevaTormenta(`sim-${estado.contadorSim}`, `Simulación ${estado.contadorSim}`, "Simulación");
    t.puntos = [{ lat, lon, viento, etiqueta: `radio ${radioKm} km` }];
    t.circulo = { lat, lon, radioKm };
    return t;
  }

  // ---------- Cálculo de exposición ----------
  function evaluar(suc, t) {
    let dist = Infinity;
    for (const linea of t.trayectoria) for (let i = 0; i < linea.length - 1; i++) dist = Math.min(dist, distSegmento(suc.lat, suc.lon, linea[i], linea[i + 1]));
    let cercano = null, dCercano = Infinity;
    for (const p of t.puntos) {
      if (p.pasado) continue;
      const d = haversine(suc.lat, suc.lon, p.lat, p.lon);
      if (d < dCercano) { dCercano = d; cercano = p; }
    }
    dist = Math.min(dist, dCercano);
    let dentroCono = t.cono.some((g) => puntoEnGeometria(suc.lat, suc.lon, g));
    if (t.circulo) {
      const d = haversine(suc.lat, suc.lon, t.circulo.lat, t.circulo.lon);
      dist = Math.max(0, d - t.circulo.radioKm);
      dentroCono = d <= t.circulo.radioKm;
    }
    if (!isFinite(dist)) return null;
    if (!dentroCono && dist > estado.radioKm) return null;

    // Viento: el del punto de pronóstico más cercano; si no hay, el máximo de la tormenta.
    let viento = cercano && cercano.viento != null ? cercano.viento : null;
    if (viento == null) {
      const vs = t.puntos.map((p) => p.viento).filter((v) => v != null);
      viento = vs.length ? Math.max(...vs) : t.vientoGlobal || 50;
    }
    const factorViento = Math.min(1, Math.max(0.25, viento / 140));
    let cercania = Math.exp(-dist / KM_DECAIMIENTO);
    if (dentroCono) cercania = Math.max(cercania, 0.6);
    const indice = Math.round(100 * factorViento * cercania);
    return { tormenta: t, dist, dentroCono, viento, etiqueta: cercano ? cercano.etiqueta : "", indice };
  }

  function nivel(indice) {
    if (indice >= 55) return "alta";
    if (indice >= 25) return "media";
    if (indice > 0) return "baja";
    return "sin";
  }

  function recalcular() {
    const visibles = estado.tormentas.filter((t) => t.visible);
    estado.resultados = estado.sucursales.map((s) => {
      let mejor = null;
      for (const t of visibles) {
        const r = evaluar(s, t);
        if (r && (!mejor || r.indice > mejor.indice || (r.indice === mejor.indice && r.dist < mejor.dist))) mejor = r;
      }
      return { s, r: mejor, nivel: mejor ? nivel(mejor.indice) : "sin" };
    });
    estado.resultados.sort((a, b) => (b.r ? b.r.indice : -1) - (a.r ? a.r.indice : -1) || (a.r ? a.r.dist : 0) - (b.r ? b.r.dist : 0));
    pintarSucursales();
    pintarResumen();
    pintarRanking();
  }

  // ---------- Render ----------
  const marcadores = new Map();

  function popupSucursal(x) {
    const s = x.s, r = x.r;
    const zoom = `https://zoom.earth/maps/satellite/#view=${s.lat.toFixed(4)},${s.lon.toFixed(4)},9z`;
    const gmaps = `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}`;
    let exp = "<p>Sin exposición con el radio actual.</p>";
    if (r) {
      const cat = categoria(r.viento);
      exp = `<p><span class="nivel ${x.nivel}"></span><strong>Índice ${r.indice}</strong> · ${esc(r.tormenta.nombre)}</p>
        <p>${r.dentroCono ? "Dentro del cono de pronóstico · " : ""}${Math.round(r.dist)} km de la trayectoria</p>
        <p>${cat.larga} (${Math.round(r.viento)} kt / ${ktAKmh(r.viento)} km/h)${r.etiqueta ? ` · ${esc(r.etiqueta)}` : ""}</p>`;
    }
    return `<div class="popup"><h3>${esc(s.nombre)} <small>#${esc(s.numero)}</small></h3>
      <p>${esc(s.direccion)}, ${esc(s.complemento)}</p>
      ${s.telefono ? `<p>Tel. ${esc(s.telefono)}</p>` : ""}
      ${exp}
      <div class="links"><a href="${zoom}" target="_blank" rel="noopener">Ver en zoom.earth ↗</a><a href="${gmaps}" target="_blank" rel="noopener">Google Maps ↗</a></div></div>`;
  }

  function pintarSucursales() {
    for (const x of estado.resultados) {
      let m = marcadores.get(x.s.numero);
      const radio = x.nivel === "alta" ? 7 : x.nivel === "media" ? 6 : x.nivel === "baja" ? 5 : 3.5;
      const estilo = { radius: radio, color: "#ffffff", weight: x.nivel === "sin" ? 0.5 : 1, fillColor: COLORES[x.nivel], fillOpacity: x.nivel === "sin" ? 0.6 : 0.95 };
      if (!m) {
        m = L.circleMarker([x.s.lat, x.s.lon], estilo).addTo(capaSucursales);
        m.bindPopup(() => popupSucursal(m._dato), { maxWidth: 320 });
        m.bindTooltip(x.s.nombre, { direction: "top" });
        marcadores.set(x.s.numero, m);
      } else {
        m.setStyle(estilo);
        m.setRadius(radio);
      }
      m._dato = x;
      if (x.nivel !== "sin") m.bringToFront();
    }
  }

  function pintarTormentas() {
    capaTormentas.clearLayers();
    estado.tormentas.forEach((t, i) => {
      if (!t.visible) return;
      const color = COLOR_TORMENTA[i % COLOR_TORMENTA.length];
      t.color = color;
      for (const g of t.cono) {
        L.geoJSON(g, { style: { color, weight: 1.5, fillColor: color, fillOpacity: 0.15 }, interactive: false }).addTo(capaTormentas);
      }
      if (t.circulo) L.circle([t.circulo.lat, t.circulo.lon], { radius: t.circulo.radioKm * 1000, color, weight: 1.5, fillOpacity: 0.15 }).addTo(capaTormentas);
      for (const l of t.pasado) L.polyline(l, { color: "#555", weight: 2, dashArray: "2 4", interactive: false }).addTo(capaTormentas);
      for (const l of t.trayectoria) L.polyline(l, { color, weight: 3, dashArray: "6 6", interactive: false }).addTo(capaTormentas);
      for (const p of t.puntos) {
        const cat = categoria(p.viento);
        L.circleMarker([p.lat, p.lon], { radius: p.pasado ? 3 : 6, color: "#000", weight: 1, fillColor: cat.color, fillOpacity: 1 })
          .bindTooltip(`<strong>${esc(t.nombre)}</strong><br>${cat.larga}${p.viento != null ? ` · ${Math.round(p.viento)} kt` : ""}${p.etiqueta ? `<br>${esc(p.etiqueta)}` : ""}`)
          .addTo(capaTormentas);
      }
    });
  }

  function pintarListaTormentas() {
    const ul = $("lista-tormentas");
    $("kpi-tormentas").textContent = estado.tormentas.filter((t) => t.visible).length;
    if (!estado.tormentas.length) {
      ul.innerHTML = `<li class="vacio">No hay tormentas cargadas. Prueba un ejemplo histórico o simula una en el mapa.</li>`;
      return;
    }
    ul.innerHTML = estado.tormentas.map((t) => {
      const vs = t.puntos.filter((p) => !p.pasado).map((p) => p.viento).filter((v) => v != null);
      const vmax = vs.length ? Math.max(...vs) : t.vientoGlobal;
      const cat = categoria(vmax);
      const afectadas = estado.resultados.filter((x) => x.r && x.r.tormenta === t).length;
      const borrable = t.fuente !== "NOAA NHC" && t.fuente !== "GDACS";
      return `<li data-id="${esc(t.id)}">
        <input type="checkbox" ${t.visible ? "checked" : ""} aria-label="Mostrar ${esc(t.nombre)}">
        <div class="info">
          <div class="nombre"><span class="cat" style="background:${cat.color}">${cat.corta}</span> ${esc(t.nombre)}</div>
          <div class="meta">${esc(t.fuente)}${t.tipo ? ` · ${esc(t.tipo)}` : ""}${vmax ? ` · máx. ${Math.round(vmax)} kt` : ""} · ${afectadas} sucursales</div>
        </div>
        <button type="button" class="ir" title="Centrar en el mapa">⌖</button>
        ${borrable ? `<button type="button" class="quitar" title="Quitar">✕</button>` : ""}
      </li>`;
    }).join("");
  }

  function pintarResumen() {
    const cuenta = { alta: 0, media: 0, baja: 0 };
    const porEstado = {};
    for (const x of estado.resultados) {
      if (x.nivel === "sin") continue;
      cuenta[x.nivel]++;
      const e = (porEstado[x.s.estado] = porEstado[x.s.estado] || { alta: 0, media: 0, baja: 0, total: 0 });
      e[x.nivel]++;
      e.total++;
    }
    $("kpi-alta").textContent = cuenta.alta;
    $("kpi-media").textContent = cuenta.media;
    $("kpi-baja").textContent = cuenta.baja;
    // Orden: primero los estados con más sucursales en exposición alta, luego media y baja.
    const peso = (e) => e.alta * 10000 + e.media * 100 + e.baja;
    const filas = Object.entries(porEstado).sort((a, b) => peso(b[1]) - peso(a[1])).slice(0, 10);
    const max = Math.max(1, ...filas.map(([, e]) => e.total));
    const tramo = (e, nv) => (e[nv] ? `<i class="${nv}" style="width:${(100 * e[nv]) / max}%" title="${e[nv]} ${nv}"></i>` : "");
    $("lista-estados").innerHTML = filas.length
      ? filas.map(([nombre, e]) => `<li><span>${esc(nombre)}</span><span class="barra">${tramo(e, "alta")}${tramo(e, "media")}${tramo(e, "baja")}</span><span class="n">${e.total}</span></li>`).join("")
      : `<li class="vacio">Sin sucursales expuestas.</li>`;
    pintarListaTormentas();
  }

  function filasFiltradas() {
    const q = $("inp-buscar").value.trim().toLowerCase();
    const ed = $("sel-estado").value;
    const solo = $("chk-solo").checked;
    return estado.resultados.filter((x) =>
      (!solo || x.r) && (!ed || x.s.estado === ed) &&
      (!q || `${x.s.nombre} ${x.s.complemento} ${x.s.numero}`.toLowerCase().includes(q)));
  }

  function pintarRanking() {
    const filas = filasFiltradas();
    const LIMITE = 300;
    $("tbody-ranking").innerHTML = filas.slice(0, LIMITE).map((x, i) => {
      const r = x.r;
      return `<tr data-num="${esc(x.s.numero)}">
        <td>${i + 1}</td>
        <td><span class="nivel ${x.nivel}"></span>${esc(x.s.nombre)}<span class="sub">${esc(x.s.estado)}</span></td>
        <td>${r ? esc(r.tormenta.nombre) + (r.dentroCono ? '<span class="sub">dentro del cono</span>' : "") : "—"}</td>
        <td class="num">${r ? Math.round(r.dist) + " km" : "—"}</td>
        <td class="num">${r ? r.indice : "—"}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" class="vacio">Sin resultados.</td></tr>`;
    $("txt-conteo").textContent = filas.length > LIMITE ? `Mostrando ${LIMITE} de ${filas.length}. Exporta el CSV para verlas todas.` : `${filas.length} sucursales.`;
  }

  function exportarCSV() {
    const cab = ["numero", "sucursal", "estado", "direccion", "latitud", "longitud", "nivel", "indice", "tormenta", "distancia_km", "dentro_cono", "viento_kt", "fecha_punto_cercano"];
    const celda = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lineas = filasFiltradas().map((x) => {
      const r = x.r;
      return [x.s.numero, x.s.nombre, x.s.estado, `${x.s.direccion}, ${x.s.complemento}`, x.s.lat, x.s.lon, x.nivel,
        r ? r.indice : "", r ? r.tormenta.nombre : "", r ? Math.round(r.dist) : "", r ? (r.dentroCono ? "sí" : "no") : "",
        r ? Math.round(r.viento) : "", r ? r.etiqueta : ""].map(celda).join(",");
    });
    const blob = new Blob(["﻿" + [cab.join(",")].concat(lineas).join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sucursales_exposicion_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function fijarEstadoFuente(texto, clase) {
    const el = $("estado-fuente");
    el.textContent = texto;
    el.className = `pill ${clase || ""}`;
  }

  function actualizarLinkZoom() {
    const c = mapa.getCenter();
    $("lnk-zoom").href = `https://zoom.earth/maps/satellite/#view=${c.lat.toFixed(3)},${c.lng.toFixed(3)},${mapa.getZoom()}z/overlays=wind`;
  }

  function encuadrarTormenta(t) {
    const capa = L.featureGroup();
    t.cono.forEach((g) => L.geoJSON(g).addTo(capa));
    t.trayectoria.forEach((l) => L.polyline(l).addTo(capa));
    t.puntos.forEach((p) => L.marker([p.lat, p.lon]).addTo(capa));
    const b = t.circulo ? L.latLng(t.circulo.lat, t.circulo.lon).toBounds(t.circulo.radioKm * 2600) : capa.getBounds();
    if (b.isValid()) mapa.fitBounds(b, { padding: [30, 30], maxZoom: 8 });
  }

  function refrescarTodo() {
    pintarTormentas();
    recalcular();
  }

  // ---------- Carga de datos ----------
  async function cargarSucursales() {
    const d = await getJSON("data/sucursales.json");
    estado.sucursales = d.sucursales.map((fila) => Object.fromEntries(d.campos.map((c, i) => [c, fila[i]])));
    const estados = [...new Set(estado.sucursales.map((s) => s.estado))].sort((a, b) => a.localeCompare(b, "es"));
    $("sel-estado").insertAdjacentHTML("beforeend", estados.map((e) => `<option>${esc(e)}</option>`).join(""));
  }

  async function cargarTormentasActivas() {
    fijarEstadoFuente("Consultando NOAA…");
    const manuales = estado.tormentas.filter((t) => t.fuente !== "NOAA NHC" && t.fuente !== "GDACS");
    let activas = [], fuente = "", error = null;
    try {
      activas = await cargarNOAA();
      fuente = "NOAA NHC";
    } catch (e) {
      error = e;
      console.warn("NOAA no disponible, usando GDACS", e);
      try {
        activas = await cargarGDACS();
        fuente = "GDACS";
      } catch (e2) {
        console.warn("GDACS no disponible", e2);
      }
    }
    estado.tormentas = activas.concat(manuales);
    const hora = new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
    if (fuente) fijarEstadoFuente(`${fuente} · ${activas.length} activa${activas.length === 1 ? "" : "s"} · ${hora}`, "ok");
    else fijarEstadoFuente(`Sin conexión a NOAA/GDACS (${error ? error.message : "error"})`, "error");
    refrescarTodo();
  }

  function cargarGeoJSONArchivo(archivo) {
    const lector = new FileReader();
    lector.onload = () => {
      try {
        const gj = JSON.parse(lector.result);
        const fc = gj.type === "FeatureCollection" ? gj : gj.type === "Feature" ? { features: [gj] } : { features: [{ type: "Feature", geometry: gj, properties: {} }] };
        const t = nuevaTormenta(`archivo-${Date.now()}`, archivo.name.replace(/\.(geo)?json$/i, ""), "Archivo");
        agregarFeatures(t, fc, "trayectoria");
        if (!t.trayectoria.length && t.puntos.length > 1) t.trayectoria.push(t.puntos.map((p) => [p.lat, p.lon]));
        estado.tormentas.push(t);
        refrescarTodo();
        encuadrarTormenta(t);
      } catch (e) {
        alert(`No se pudo leer el GeoJSON: ${e.message}`);
      }
    };
    lector.readAsText(archivo);
  }

  // ---------- Eventos ----------
  $("btn-actualizar").addEventListener("click", cargarTormentasActivas);
  $("btn-csv").addEventListener("click", exportarCSV);
  ["inp-buscar", "sel-estado", "chk-solo"].forEach((id) => $(id).addEventListener("input", pintarRanking));
  $("rng-radio").addEventListener("input", (e) => {
    estado.radioKm = Number(e.target.value);
    $("lbl-radio").textContent = `${estado.radioKm} km`;
    recalcular();
  });
  $("sel-ejemplo").addEventListener("change", (e) => {
    const clave = e.target.value;
    e.target.value = "";
    if (!clave) return;
    let t = estado.tormentas.find((x) => x.id === `ejemplo-${clave}`);
    if (!t) { t = tormentaEjemplo(clave); estado.tormentas.push(t); }
    t.visible = true;
    refrescarTodo();
    encuadrarTormenta(t);
  });
  $("btn-simular").addEventListener("click", () => {
    estado.simulando = !estado.simulando;
    $("btn-simular").classList.toggle("activo", estado.simulando);
    $("cfg-simulacion").hidden = !estado.simulando;
    document.querySelector(".mapa-wrap").classList.toggle("simulando", estado.simulando);
  });
  mapa.on("click", (e) => {
    if (!estado.simulando) return;
    const t = tormentaSimulada(e.latlng.lat, e.latlng.lng, Number($("sim-cat").value), Number($("sim-radio").value) || 150);
    estado.tormentas.push(t);
    refrescarTodo();
  });
  $("inp-geojson").addEventListener("change", (e) => {
    if (e.target.files[0]) cargarGeoJSONArchivo(e.target.files[0]);
    e.target.value = "";
  });
  $("lista-tormentas").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const t = estado.tormentas.find((x) => x.id === li.dataset.id);
    if (!t) return;
    if (e.target.matches("input[type=checkbox]")) { t.visible = e.target.checked; refrescarTodo(); }
    else if (e.target.closest(".quitar")) { estado.tormentas = estado.tormentas.filter((x) => x !== t); refrescarTodo(); }
    else if (e.target.closest(".ir")) encuadrarTormenta(t);
  });
  $("tbody-ranking").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-num]");
    const m = tr && marcadores.get(tr.dataset.num);
    if (!m) return;
    mapa.setView(m.getLatLng(), Math.max(mapa.getZoom(), 9));
    m.openPopup();
  });
  mapa.on("moveend", actualizarLinkZoom);
  actualizarLinkZoom();

  // ---------- Arranque ----------
  (async function iniciar() {
    try {
      await cargarSucursales();
    } catch (e) {
      fijarEstadoFuente("No se pudieron cargar las sucursales", "error");
      console.error(e);
      return;
    }
    recalcular();
    const ejemplo = new URLSearchParams(location.search).get("ejemplo");
    if (ejemplo && EJEMPLOS[ejemplo]) {
      const t = tormentaEjemplo(ejemplo);
      estado.tormentas.push(t);
      refrescarTodo();
      encuadrarTormenta(t);
    }
    await cargarTormentasActivas();
    setInterval(cargarTormentasActivas, REFRESCO_MS);
  })();
})();
