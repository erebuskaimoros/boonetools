import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const source = readFileSync(new URL('../src/lib/financials/DayDetail.svelte', import.meta.url), 'utf8');
const styles = postcss.parse(source.match(/<style>([\s\S]*?)<\/style>/)[1]);

function hasRightAlignedClass(classes) {
  let rightAligned = false;
  styles.walkRules(rule => {
    if (!rule.selectors.some(selector => classes.some(name => selector.trim() === `.${name}`))) return;
    rule.walkDecls('text-align', declaration => {
      if (declaration.value === 'right') rightAligned = true;
    });
  });
  return rightAligned;
}

for (const label of ['VALUE', 'VOLUME']) {
  test(`Financials ${label} header aligns with the right-aligned currency amounts`, () => {
    const header = source.match(new RegExp(`<th\\b([^>]*)>${label}</th>`));
    assert.ok(header, `${label} column header exists`);
    const classes = (header[1].match(/class="([^"]*)"/)?.[1] || '').split(/\s+/).filter(Boolean);
    assert.ok(hasRightAlignedClass(classes), `${label} header must share the amounts' right alignment`);
    assert.ok(hasRightAlignedClass(['amount']), 'currency amounts remain right-aligned');
  });
}
