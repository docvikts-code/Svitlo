import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('www', { recursive: true });
await build({ entryPoints: ['src/app.js'], outfile: 'www/app.js', bundle: true,
  format: 'iife', target: ['chrome100', 'safari15'], minify: true });
const html = await readFile('svitlo-ternopil.html', 'utf8');
await writeFile('www/index.html', html);
await writeFile('www/svitlo-ternopil.html', html);
await copyFile('src/style.css', 'www/style.css');
console.log('Готово: www/');
