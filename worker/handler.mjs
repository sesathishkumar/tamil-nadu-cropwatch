const WORLD_COVER = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/';
const types = {
  '/': 'text/html',
  '/app.js': 'text/javascript',
  '/satellite.js': 'text/javascript',
  '/style.css': 'text/css'
};

export default {
  async fetch(request) {
    const {pathname} = new URL(request.url);
    if (request.method !== 'GET') return new Response('Method not allowed', {status:405, headers:{Allow:'GET'}});
    if (Object.hasOwn(ASSETS, pathname)) {
      return new Response(ASSETS[pathname], {headers:{'Content-Type':types[pathname] + '; charset=utf-8'}});
    }
    const match = pathname.match(/^\/api\/worldcover\/(N(?:09|12)E(?:075|078))$/);
    if (!match) return new Response('Not found', {status:404});
    const range = request.headers.get('range');
    const bytes = range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!bytes || Number(bytes[2]) < Number(bytes[1]) || Number(bytes[2]) - Number(bytes[1]) >= 32 * 1024 * 1024) {
      return new Response('A single bounded byte range is required.', {status:416});
    }
    try {
      const raster = WORLD_COVER + 'ESA_WorldCover_10m_2021_v200_' + match[1] + '_Map.tif';
      const response = await fetch(raster, {headers:{Range:range}, redirect:'error'});
      if (response.status !== 206) {
        await response.body?.cancel();
        return new Response('The raster provider did not return the requested range.', {status:502});
      }
      const headers = new Headers({'Content-Type':'image/tiff', 'Cache-Control':'public, max-age=86400'});
      for (const name of ['content-range','content-length','accept-ranges']) {
        const value = response.headers.get(name);
        if (value) headers.set(name,value);
      }
      return new Response(response.body,{status:206,headers});
    } catch {
      return new Response('The cropland raster provider could not be reached.', {status:502});
    }
  }
};
