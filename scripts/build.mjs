import {mkdir, readFile, writeFile} from 'node:fs/promises';
const files = {'/':'index.html','/app.js':'app.js','/satellite.js':'satellite.js','/style.css':'style.css'};
const assets = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([route,file]) =>
  [route,await readFile('web/' + file,'utf8')])));
await mkdir('dist/server',{recursive:true});
const handler = await readFile('worker/handler.mjs','utf8');
await writeFile('dist/server/index.js','const ASSETS = ' + JSON.stringify(assets) + ';\n' + handler);
