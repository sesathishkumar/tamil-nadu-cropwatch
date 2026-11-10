const EARTH_SEARCH = 'https://earth-search.aws.element84.com/v1/search';
const WORLDCOVER = '/api/worldcover/';
const STEP = .00225;
const RAD = Math.PI / 180;

function contains(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = ring[i], [c, d] = ring[j];
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) inside = !inside;
  }
  return inside;
}

export function gridFor(geometry) {
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let west = 180, east = -180, south = 90, north = -90;
  for (const [outer] of polygons) for (const [x, y] of outer) {
    west = Math.min(x, west);
    east = Math.max(x, east);
    south = Math.min(y, south);
    north = Math.max(y, north);
  }
  const cols = Math.ceil((east - west) / STEP), rows = Math.ceil((north - south) / STEP);
  east = west + cols * STEP;
  south = north - rows * STEP;
  if (!rows || !cols || rows * cols > 350000) throw new Error('Unexpected district boundary size.');
  const points = [];
  for (let row = 0; row < rows; row++) {
    const y = north - (row + .5) * STEP;
    const hectares = 6371008.8 ** 2 * STEP * RAD *
      (Math.sin((y + STEP / 2) * RAD) - Math.sin((y - STEP / 2) * RAD)) / 10000;
    for (let col = 0; col < cols; col++) {
      const x = west + (col + .5) * STEP;
      if (polygons.some(([outer, ...holes]) => contains(x, y, outer) && !holes.some(ring => contains(x, y, ring)))) {
        points.push({x, y, row, col, hectares, value: null});
      }
    }
  }
  return {bounds:[west,south,east,north], rows, cols, points};
}

function projectFor(image) {
  const {ProjectedCSTypeGeoKey: epsg} = image.getGeoKeys();
  if (!epsg || epsg === 4326) return (x,y) => [x,y];
  if (epsg < 32601 || epsg > 32660) throw new Error('Unsupported imagery projection.');
  const transform = proj4('EPSG:4326', '+proj=utm +zone=' + (epsg - 32600) + ' +datum=WGS84 +units=m +no_defs');
  return (x,y) => transform.forward([x,y]);
}

async function samplesFrom(url, points, signal) {
  const tiff = await GeoTIFF.fromUrl(url, {blockSize:65536, cacheSize:48}, signal);
  const base = await tiff.getImage();
  const project = projectFor(base);
  const origin = base.getOrigin();
  const maxResolution = base.getGeoKeys().ProjectedCSTypeGeoKey ? 120 : .0011;
  let image = base;
  for (let n = 1, count = await tiff.getImageCount(); n < count; n++) {
    const candidate = await tiff.getImage(n);
    if (!(candidate.getFileDirectory().NewSubfileType & 1)) continue;
    const resolution = Math.abs(candidate.getResolution(base)[0]);
    if (resolution <= maxResolution && resolution > Math.abs(image.getResolution(base)[0])) image = candidate;
  }
  const [dx,dy] = image.getResolution(base);
  const width = image.getWidth(), height = image.getHeight();
  let left = width, top = height, right = -1, bottom = -1;
  const indices = new Int32Array(points.length).fill(-1);
  points.forEach(({x,y}, index) => {
    const [east,north] = project(x,y);
    const i = Math.floor((east - origin[0]) / dx), j = Math.floor((north - origin[1]) / dy);
    if (i < 0 || i >= width || j < 0 || j >= height) return;
    indices[index] = j * width + i;
    left = Math.min(left,i); right = Math.max(right,i);
    top = Math.min(top,j); bottom = Math.max(bottom,j);
  });
  if (right < left) return new Int32Array(points.length).fill(-1);
  const [pixels] = await image.readRasters({window:[left,top,right+1,bottom+1], samples:[0], signal});
  const stride = right + 1 - left;
  return indices.map(index => index < 0 ? -1 :
    pixels[(Math.floor(index / width) - top) * stride + index % width - left]);
}

function assetUrl(asset) {
  const href = asset.href;
  return href.startsWith('s3://sentinel-cogs/') ?
    href.replace('s3://sentinel-cogs/', 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/') : href;
}

function reflectance(value, asset) {
  const band = asset['raster:bands']?.[0];
  return value * (band?.scale ?? .0001) + (band?.offset ?? -.1);
}

export async function calculate(geometry, signal, progress, day = new Date()) {
  const grid = gridFor(geometry);
  const groups = new Map();
  for (const point of grid.points) {
    const tile = 'N' + String(3 * Math.floor(point.y / 3)).padStart(2, '0') +
      'E' + String(3 * Math.floor(point.x / 3)).padStart(3, '0');
    if (!groups.has(tile)) groups.set(tile, []);
    groups.get(tile).push(point);
  }
  const start = new Date(day.getTime() - 30 * 86400000);
  const query = new URLSearchParams({
    collections:'sentinel-2-l2a', bbox:grid.bounds.join(','),
    datetime:start.toISOString() + '/' + day.toISOString(), limit:'100',
    sortby:'-properties.datetime'
  });
  progress('Finding Sentinel‑2 scenes and loading the ESA cropland baseline…');
  const [catalog] = await Promise.all([
    fetch(EARTH_SEARCH + '?' + query, {signal}).then(response => {
      if (!response.ok) throw new Error('The Sentinel‑2 catalogue returned HTTP ' + response.status + '.');
      return response.json();
    }),
    Promise.all([...groups].map(async ([tile, points]) => {
      const pixels = await samplesFrom(WORLDCOVER + tile, points, signal);
      points.forEach((point, index) => { point.crop = pixels[index] === 40; });
    }))
  ]);
  const crop = grid.points.filter(point => point.crop);
  const scenes = new Map();
  for (const scene of (catalog.features ?? []).sort((a,b) => b.properties.datetime.localeCompare(a.properties.datetime))) {
    const {assets, properties} = scene;
    const cloud = properties['eo:cloud_cover'];
    if (!assets.red || !assets.nir || !assets.scl || cloud >= 95 || !scene.bbox || !properties.datetime) continue;
    const key = properties['grid:code'] ?? properties['s2:mgrs_tile'] ?? scene.id.match(/^S2[A-Z]_(\d{2}[A-Z]{3})_/)?.[1] ?? scene.bbox.join();
    if (!scenes.has(key)) scenes.set(key, []);
    if (scenes.get(key).length < 5) scenes.get(key).push(scene);
  }
  const ordered = [...scenes.values()].flat().sort((a,b) => b.properties.datetime.localeCompare(a.properties.datetime));
  let failures = 0;
  for (const [index, scene] of ordered.entries()) {
    signal.throwIfAborted();
    const [w,s,e,n] = scene.bbox;
    const selected = crop.filter(point => point.value === null && point.x >= w && point.x <= e && point.y >= s && point.y <= n);
    if (!selected.length) continue;
    progress('Reading satellite scene ' + (index + 1) + ' of ' + ordered.length + '…');
    try {
      const {red,nir,scl} = scene.assets;
      const classes = await samplesFrom(assetUrl(scl), selected, signal);
      const clear = selected.filter((_, i) => classes[i] === 4 || classes[i] === 5);
      if (!clear.length) continue;
      const [reds,nirs] = await Promise.all([
        samplesFrom(assetUrl(red), clear, signal), samplesFrom(assetUrl(nir), clear, signal)
      ]);
      clear.forEach((point, i) => {
        if (reds[i] <= 0 || nirs[i] <= 0) return;
        const r = Math.max(0, reflectance(reds[i], red)), n = Math.max(0, reflectance(nirs[i], nir));
        if (r + n <= 0) return;
        point.value = (n - r) / (n + r);
        point.date = scene.properties.datetime.slice(0,10);
      });
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn('Unable to read scene', scene.id, error);
      failures++;
    }
  }
  return {...grid, points:crop, failures};
}

export function summarize(points, filter = () => true) {
  let baseline = 0, observed = 0, active = 0;
  const dates = new Set();
  for (const point of points) {
    if (!filter(point)) continue;
    baseline += point.hectares;
    if (point.value === null) continue;
    observed += point.hectares;
    if (point.value >= .35) active += point.hectares;
    dates.add(point.date);
  }
  return {baseline, observed, active, dates:[...dates].sort()};
}
