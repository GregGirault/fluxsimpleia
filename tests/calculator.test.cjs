const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(script, 'inline calculator script exists');

function createPage() {
  const inputs = new Map(['a-spend', 'a-jobs', 'b-spend', 'b-jobs'].map(id => [id, { value: '' }]));
  const listeners = {};
  const result = {
    textContent: '',
    children: [],
    replaceChildren() { this.textContent = ''; this.children = []; },
    append(...children) { this.children.push(...children); },
  };
  const form = { addEventListener(name, handler) { listeners[name] = handler; } };
  const document = {
    getElementById(id) { return id === 'cost-form' ? form : id === 'cost-result' ? result : inputs.get(id); },
    createElement(tag) { return { tag, textContent: '' }; },
  };
  vm.runInNewContext(script[1], { document, Intl, Number, Math }, { timeout: 1000 });
  assert.equal(typeof listeners.input, 'function');
  assert.equal(typeof listeners.submit, 'function');
  return {
    set(values) {
      for (const [id, value] of Object.entries(values)) inputs.get(id).value = String(value);
      listeners.input();
      return [result.textContent, ...result.children.map(x => x.textContent)].join(' ');
    },
    submit() {
      let prevented = false;
      listeners.submit({ preventDefault() { prevented = true; } });
      return prevented;
    },
  };
}

test('shows observed cost per successful job and difference', () => {
  const page = createPage();
  const output = page.set({ 'a-spend': 10, 'a-jobs': 20, 'b-spend': 12, 'b-jobs': 20 });
  assert.match(output, /Provider A is cheaper/);
  assert.match(output, /16\.7% lower/);
  assert.match(output, /\$0\.50/);
  assert.match(output, /\$0\.60/);
});

test('prevents invalid division and malformed values', () => {
  const page = createPage();
  for (const value of ['0', '-1', '1.5', 'not a number']) {
    const output = page.set({ 'a-spend': 10, 'a-jobs': value, 'b-spend': 12, 'b-jobs': 20 });
    assert.match(output, /positive whole number/);
  }
});

test('handles two zero-spend providers and form submission safely', () => {
  const page = createPage();
  const output = page.set({ 'a-spend': 0, 'a-jobs': 10, 'b-spend': 0, 'b-jobs': 5 });
  assert.match(output, /cost the same/);
  assert.equal(page.submit(), true);
});
