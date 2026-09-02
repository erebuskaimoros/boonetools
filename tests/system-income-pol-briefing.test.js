import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const briefingUrl = new URL('../src/lib/SystemIncomePolBriefing.svelte', import.meta.url);

test('POL briefing includes its original cover image before the article title', async () => {
  const source = await readFile(briefingUrl, 'utf8');
  const cover = source.match(/<img\b[^>]*class="article-cover"[^>]*>/);
  assert.ok(cover, 'The original article cover must be rendered');
  assert.match(cover[0], /alt="[^"]+"/);
  assert.match(cover[0], /src=\{COVER_URL\}/);
  assert.match(cover[0], /width="846"/);
  assert.match(cover[0], /height="338"/);
  assert.ok(cover.index < source.indexOf('<h1>'), 'Keep the original cover-before-title order');
  assert.match(source, /\.article-cover\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;/);
});

test('POL briefing cover is bundled locally rather than hotlinked to X', async () => {
  const source = await readFile(briefingUrl, 'utf8');
  const assetPath = source.match(/\/assets\/briefings\/thorchain-new-pol\/cover\.(?:jpg|jpeg|png|webp)/)?.[0];
  assert.ok(assetPath, 'The cover must have a durable local asset path');
  const image = await readFile(new URL(`../public${assetPath}`, import.meta.url));
  assert.ok(image.length > 1000, 'The bundled cover must contain image data');
  const isJpeg = image.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isPng = image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
  assert.ok(isJpeg || isPng || isWebp, 'The asset must be a real image, not an HTML error response');
});

test('POL briefing includes the original IP chart in its article body', async () => {
  const source = await readFile(briefingUrl, 'utf8');
  const chart = source.match(/<img\b[^>]*class="article-chart"[^>]*>/);
  assert.ok(chart, 'The original IP chart must be rendered');
  assert.match(chart[0], /alt="[^"]+"/);
  assert.match(chart[0], /src=\{IP_CHART_URL\}/);
  assert.match(chart[0], /width="1200"/);
  assert.match(chart[0], /height="675"/);
  assert.ok(chart.index > source.indexOf('<h2>Background</h2>'));
  assert.ok(chart.index < source.indexOf('Ever since the ThorFi collapse'));
  assert.match(source, /<figcaption>\s*Shows where TC rewards have gone historically\. Note LPs have gotten nothing since ThorFi\.\s*<\/figcaption>/);
  assert.match(source, /\.article-chart\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;/);
});

test('POL briefing IP chart is bundled locally rather than hotlinked to X', async () => {
  const source = await readFile(briefingUrl, 'utf8');
  const assetPath = source.match(/\/assets\/briefings\/thorchain-new-pol\/ip-chart\.(?:jpg|jpeg|png|webp)/)?.[0];
  assert.ok(assetPath, 'The IP chart must have a durable local asset path');
  const image = await readFile(new URL(`../public${assetPath}`, import.meta.url));
  assert.ok(image.length > 1000, 'The bundled IP chart must contain image data');
  const isJpeg = image.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isPng = image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
  assert.ok(isJpeg || isPng || isWebp, 'The IP chart must be a real image, not an HTML error response');
});
