import {calculate, summarize} from './satellite.js';

const districts = {
  thanjavur: {name:'Thanjavur', center:[10.65,79.22], net:194736, gross:298503},
  dindigul: {name:'Dindigul', center:[10.33,77.78], net:216306, gross:222552},
  cuddalore: {name:'Cuddalore', center:[11.51,79.49], net:211703, gross:316892}
};
const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('en-IN', {maximumFractionDigits:0});
const date = new Intl.DateTimeFormat('en-IN', {day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Kolkata'});
const cached = new Map();
const boundaries = new Map();
let selected, controller, result, outline, overlay, box, corner, drawing = false, map, basemap;
const layers = {};

if (window.L) {
  $('map').replaceChildren();
  map = L.map('map', {crs:L.CRS.EPSG3857, scrollWheelZoom:false}).setView(districts.thanjavur.center, 9);
  layers.terrain = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  });
  layers.imagery = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom:19, attribution:'Imagery &copy; Esri and imagery providers'
  });
  basemap = layers.terrain.addTo(map);
  map.on('click', ({latlng}) => {
    if (!drawing) return;
    if (!corner) {
      corner = latlng;
      $('draw-note').textContent = 'Select the opposite corner.';
      return;
    }
    if (map.distance(corner, latlng) < 300) {
      $('draw-note').textContent = 'Choose a corner at least 300 m away.';
      return;
    }
    box = L.rectangle(L.latLngBounds(corner,latlng), {color:'#243a33', weight:2, dashArray:'6 5',fill:false}).addTo(map);
    $('clear').hidden = false;
    setDrawing(false);
    showMetrics();
  });
  $('basemap').addEventListener('change', event => {
    basemap.remove();
    basemap = layers[event.target.value].addTo(map);
  });
} else {
  $('map').textContent = 'The map library could not load. Annual figures are available below.';
  $('basemap').disabled = true;
}

function setDrawing(active) {
  drawing = active;
  corner = null;
  $('draw').setAttribute('aria-pressed', String(active));
  $('draw').textContent = active ? 'Cancel drawing' : 'Draw area';
  $('draw-note').textContent = active ? 'Select the first corner on the map.' :
    box ? 'Results apply inside the selected district and rectangle.' : 'Select two opposite corners to measure a rectangle.';
  map?.getContainer().classList.toggle('draw-mode',active);
}

function clearSelection() {
  box?.remove();
  box = null;
  $('clear').hidden = true;
  setDrawing(false);
  showMetrics();
}

$('draw').addEventListener('click', () => {
  if (drawing) setDrawing(false);
  else {
    clearSelection();
    setDrawing(true);
  }
});
$('clear').addEventListener('click', clearSelection);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && drawing) setDrawing(false);
});

async function boundary(key, signal) {
  if (boundaries.has(key)) return boundaries.get(key);
  const url = 'https://livingatlas.esri.in/server/rest/services/IAB2024/India_Administrative_Boundaries_2024/MapServer/2/query';
  const params = new URLSearchParams({
    where:"LOWER(state) = 'tamil nadu' AND LOWER(name) = '" + key + "'",
    outFields:'name', returnGeometry:'true', outSR:'4326', maxAllowableOffset:'0.001', f:'geojson'
  });
  let response;
  try {
    response = await fetch(url + '?' + params, {signal});
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('The district boundary service could not be reached.');
  }
  if (!response.ok) throw new Error('The district boundary service returned HTTP ' + response.status + '.');
  const data = await response.json();
  const feature = data.features?.[0];
  if (!['Polygon','MultiPolygon'].includes(feature?.geometry?.type)) throw new Error('The district boundary is unavailable.');
  boundaries.set(key, feature);
  return feature;
}

function showMetrics() {
  const name = districts[selected]?.name;
  if (!name) return;
  $('area-label').textContent = 'Estimated green cropland in ' + (box ? 'selected area' : name);
  const b = box?.getBounds();
  const summary = result && summarize(result.points, b ? ({x,y}) => b.contains([y,x]) : undefined);
  $('active-ha').textContent = summary?.observed ? number.format(summary.active) : '—';
  $('coverage').textContent = summary?.baseline ? (100 * summary.observed / summary.baseline).toFixed(1) + '%' : '—';
  const days = summary?.dates ?? [];
  const formatDay = day => date.format(new Date(day + 'T00:00:00Z'));
  $('observed').textContent = !days.length ? '—' : days.length === 1 ? formatDay(days[0]) :
    formatDay(days[0]) + ' – ' + formatDay(days.at(-1));
}

function showLayer(data) {
  result = data;
  showMetrics();
  overlay?.remove();
  if (!map) return;
  const canvas = document.createElement('canvas');
  canvas.width = data.cols;
  canvas.height = data.rows;
  const context = canvas.getContext('2d');
  const image = context.createImageData(data.cols, data.rows);
  for (const {row,col,value} of data.points) {
    const color = value === null ? [97,111,119,165] : value >= .35 ? [22,126,71,218] : [204,162,62,165];
    image.data.set(color, (row * data.cols + col) * 4);
  }
  context.putImageData(image,0,0);
  const [w,s,e,n] = data.bounds;
  // The analysis grid uses linear latitude, so warp its rows to Web Mercator for display.
  const projected = document.createElement('canvas');
  projected.width = data.cols;
  projected.height = data.rows;
  const out = projected.getContext('2d');
  out.imageSmoothingEnabled = false;
  const top = L.CRS.EPSG3857.project(L.latLng(n,0)).y;
  const bottom = L.CRS.EPSG3857.project(L.latLng(s,0)).y;
  for (let row = 0; row < data.rows; row++) {
    const y = top + (row + .5) / data.rows * (bottom - top);
    const latitude = L.CRS.EPSG3857.unproject(L.point(0,y)).lat;
    const src = Math.min(data.rows-1, Math.max(0, Math.floor((n - latitude) / (n - s) * data.rows)));
    out.drawImage(canvas,0,src,data.cols,1,0,row,data.cols,1);
  }
  overlay = L.imageOverlay(projected.toDataURL(), [[s,w],[n,e]], {opacity:.8,interactive:false}).addTo(map);
}

function showResult(data) {
  showLayer(data);
  const {observed,baseline} = summarize(data.points);
  $('status').textContent = !baseline ? 'The baseline has no mapped cropland in this district.' :
    !observed ? (data.failures ? 'Satellite raster downloads failed. Please try again.' : 'No clear crop observations in the current window.') :
    observed / baseline < .7 ? 'Partial coverage. The estimate covers only clearly observed cropland.' :
    'Estimate calculated from the recent imagery shown above.';
}

async function refresh(force = false, fit = false) {
  const key = selected;
  controller?.abort();
  const running = new AbortController();
  controller = running;
  const timeout = setTimeout(() => running.abort(new DOMException('The satellite request timed out.','TimeoutError')), 120000);
  const status = message => { if (controller === running) $('status').textContent = message; };
  $('refresh').disabled = true;
  status('Loading district boundary…');
  try {
    const feature = await boundary(key, running.signal);
    running.signal.throwIfAborted();
    if (map && (fit || !outline)) {
      outline?.remove();
      outline = L.geoJSON(feature,{style:{color:'#234e3c',weight:2,fill:false},interactive:false}).addTo(map);
      map.fitBounds(outline.getBounds(), {padding:[15,15]});
      $('draw').disabled = false;
    }
    if (!window.GeoTIFF || !window.proj4) throw new Error('The satellite processing libraries could not load.');
    const stored = cached.get(key);
    if (!force && stored && Date.now() - stored.time < 1800000) {
      showResult(stored.data);
      return;
    }
    const data = await calculate(feature.geometry, running.signal, status);
    running.signal.throwIfAborted();
    if (summarize(data.points).observed) cached.set(key,{data,time:Date.now()});
    showResult(data);
  } catch (error) {
    if (controller !== running) return;
    console.warn(error);
    const message = error.name === 'TimeoutError' ? 'Satellite data took too long to load.' :
      ['Failed to fetch','Request failed'].includes(error.message) ? 'A satellite data source could not be reached.' : error.message;
    status(message + (result ? ' The previous estimate is still shown.' : ' Please try again.'));
  } finally {
    clearTimeout(timeout);
    if (controller === running) $('refresh').disabled = false;
  }
}

function selectDistrict(key) {
  if (selected === key) return;
  selected = key;
  result = null;
  outline?.remove();
  overlay?.remove();
  outline = overlay = null;
  $('draw').disabled = true;
  clearSelection();
  const {name,center,net,gross} = districts[key];
  map?.setView(center,9);
  $('district-name').textContent = name;
  $('official-name').textContent = name;
  $('net-ha').textContent = number.format(net) + ' ha';
  $('gross-ha').textContent = number.format(gross) + ' ha';
  document.querySelectorAll('[data-district]').forEach(button =>
    button.setAttribute('aria-pressed', String(button.dataset.district === key)));
  refresh(false,true);
}

document.querySelectorAll('[data-district]').forEach(button =>
  button.addEventListener('click', () => selectDistrict(button.dataset.district)));
$('refresh').addEventListener('click', () => refresh(true));
selectDistrict('thanjavur');
setInterval(() => { if (!document.hidden && !$('refresh').disabled) refresh(true); }, 1800000);
