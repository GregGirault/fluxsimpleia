import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guide = readFileSync(join(root, 'provider-guide.html'), 'utf8');
const home = readFileSync(join(root, 'index.html'), 'utf8');
const sitemap = readFileSync(join(root, 'sitemap.xml'), 'utf8');

test('provider guide uses a crawlable canonical path and meaningful metadata', () => {
  assert.match(guide, /<html lang="en">/);
  assert.match(guide, /<meta name="description"/);
  assert.match(guide, /<link rel="canonical" href="https:\/\/greggirault\.github\.io\/fluxsimpleia\/provider-guide\.html">/);
  assert.match(sitemap, /<loc>https:\/\/greggirault\.github\.io\/fluxsimpleia\/provider-guide\.html<\/loc>/);
  assert.match(home, /href="provider-guide\.html"/);
});

test('every referral link is disclosed and uses sponsored relation', () => {
  const links = [...guide.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/g)];
  const affiliates = links.filter(([, href]) => [
    'deepkey.top/register?aff=',
    'xclis.ai/ref/',
    'muskapi.cc/register?ref=',
  ].some(part => href.includes(part)));
  assert.equal(affiliates.length, 3);
  for (const [raw] of affiliates) {
    assert.match(raw, /rel="[^"]*sponsored/);
    assert.match(raw, /noopener/);
    assert.match(raw, /noreferrer/);
  }
  assert.match(guide, /may earn me a commission/);
  assert.match(guide, /not independent speed, security, reliability, model quality or price/);
});

test('provider docs link directly to identifiable public source domains', () => {
  for (const source of [
    'https://doc.deepkey.top/',
    'https://xclis.ai/docs',
    'https://docs.muskapi.cc/en/',
    'https://docs.muskapi.cc/en/guide/personal-management-api',
  ]) assert.ok(guide.includes(`href="${source}"`), source);
});

test('preflight has exactly six usable checkbox controls and no silent tracking', () => {
  assert.equal([...guide.matchAll(/type="checkbox"/g)].length, 6);
  assert.ok(!/<script\b/i.test(guide), 'guide should not execute tracking or remote scripts');
  assert.match(guide, /runs no API requests, collects no keys and sends no data/i);
});

test('relative links resolve to real public site artifacts', () => {
  const localLinks = [...guide.matchAll(/href="([^"]+)"/g)]
    .map(match => match[1])
    .filter(href => !href.startsWith('https://') && !href.startsWith('http://') && !href.startsWith('#'));
  assert.ok(localLinks.length >= 5);
  for (const href of localLinks) {
    const safePath = href.split('#')[0].split('?')[0];
    const absolute = resolve(root, safePath);
    assert.ok(absolute.startsWith(root), `relative link cannot escape root: ${href}`);
    assert.ok(existsSync(absolute), `missing resource: ${href}`);
  }
});
