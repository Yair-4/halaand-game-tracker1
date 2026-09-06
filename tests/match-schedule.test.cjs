const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const appScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener({ type, target: this });
    }
  };
}

function element() {
  let markup = '';
  const classes = new Set();
  return {
    ...eventTarget(),
    dataset: {},
    hidden: false,
    style: {},
    attributes: {},
    classList: {
      toggle(name, force = !classes.has(name)) {
        if (force) classes.add(name); else classes.delete(name);
        return force;
      }
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = String(value); },
    get textContent() { return markup.replace(/<[^>]+>/g, ''); },
    set textContent(value) { markup = String(value); }
  };
}

function loadApp(iso, { reverseFixtures = false } = {}) {
  let now = Date.parse(iso);
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [`#${match[1]}`, element()]));
  const buttons = ['all', 'city', 'norway'].map(filter => Object.assign(element(), { dataset: { filter } }));
  const document = Object.assign(eventTarget(), {
    documentElement: element(),
    visibilityState: 'visible',
    hidden: false,
    querySelector(selector) {
      assert.ok(elements.has(selector), `DOM fixture missing ${selector}`);
      return elements.get(selector);
    },
    querySelectorAll(selector) {
      assert.equal(selector, '.filter-btn');
      return buttons;
    }
  });
  const window = eventTarget();
  const intervals = [];
  let source = appScript;
  if (reverseFixtures) {
    const fixtureDeclaration = /const upcoming = (\[[\s\S]*?\n    \]);/;
    assert.match(source, fixtureDeclaration);
    source = source.replace(fixtureDeclaration, 'const upcoming = ($1).reverse();');
  }
  vm.runInNewContext(source, {
    Date: TestDate,
    Intl,
    document,
    navigator: { onLine: true },
    location: { protocol: 'https:' },
    console,
    window,
    addEventListener: window.addEventListener.bind(window),
    setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; }
  }, { filename: 'index.html:inline-script' });

  return {
    text: id => elements.get(`#${id}`).textContent,
    markup: id => elements.get(`#${id}`).innerHTML,
    setTime(iso) { now = Date.parse(iso); },
    tick() {
      assert.ok(intervals.length, 'The page must schedule automatic refreshes');
      for (const { callback } of intervals) callback();
    },
    select(filter) { buttons.find(button => button.dataset.filter === filter).dispatch('click'); },
    visibility(state) {
      document.visibilityState = state;
      document.hidden = state !== 'visible';
      document.dispatch('visibilitychange');
    },
    pageshow() { window.dispatch('pageshow'); }
  };
}

function fixtureCount(app) {
  return (app.markup('upcoming-list').match(/<article\b/g) || []).length;
}

function assertUpcoming(app, opponent, count) {
  assert.match(app.text('next-match-title'), new RegExp(opponent));
  assert.equal(app.text('upcoming-count'), String(count));
  assert.equal(fixtureCount(app), count);
  assert.doesNotMatch(app.text('countdown'), /Kickoff time reached/);
}

test('September 6 skips the previous day\'s match for all three filters', () => {
  const app = loadApp('2026-09-06T09:00:00Z');
  assertUpcoming(app, 'Man United', 7);
  assert.doesNotMatch(app.markup('upcoming-list'), /Coventry/);
  app.select('city');
  assertUpcoming(app, 'Man United', 3);
  assert.doesNotMatch(app.markup('upcoming-list'), /Denmark/);
  app.select('norway');
  assertUpcoming(app, 'Denmark', 4);
  assert.doesNotMatch(app.markup('upcoming-list'), /Man City/);
  app.select('all');
  assertUpcoming(app, 'Man United', 7);
});

test('future fixtures are ordered by kickoff even if the snapshot is unsorted', () => {
  const app = loadApp('2026-09-06T09:00:00Z', { reverseFixtures: true });
  assertUpcoming(app, 'Man United', 7);
  const kickoffs = [...new Set([...app.markup('upcoming-list').matchAll(/datetime="([^"]+)"/g)].map(match => match[1]))];
  assert.deepEqual(kickoffs, [...kickoffs].sort());
  app.select('norway');
  assertUpcoming(app, 'Denmark', 4);
});

test('an open page rolls its hero, list, and count at the exact kickoff', () => {
  const app = loadApp('2026-09-05T13:59:59Z');
  assertUpcoming(app, 'Coventry', 8);
  app.setTime('2026-09-05T14:00:00Z');
  app.tick();
  assertUpcoming(app, 'Man United', 7);
  assert.doesNotMatch(app.markup('upcoming-list'), /Coventry/);
  app.setTime('2026-09-17T18:30:00Z');
  app.tick();
  assertUpcoming(app, 'Sunderland', 5);
});

test('the timer also rolls the selected Norway schedule at kickoff', () => {
  const app = loadApp('2026-09-24T18:44:59Z');
  app.select('norway');
  assertUpcoming(app, 'Denmark', 4);
  app.setTime('2026-09-24T18:45:00Z');
  app.tick();
  assertUpcoming(app, 'Portugal', 3);
  assert.doesNotMatch(app.markup('upcoming-list'), /Denmark/);
});

test('an exhausted team filter stays empty while another team has future fixtures', () => {
  const app = loadApp('2026-10-02T09:00:00Z');
  app.select('city');
  assert.equal(app.text('next-match-title'), 'No upcoming matches');
  assert.equal(app.text('countdown'), 'Waiting for schedule updates');
  assert.equal(app.text('upcoming-count'), '0');
  assert.equal(fixtureCount(app), 0);
  assert.doesNotMatch(app.text('hero-venue'), /Etihad|Old Trafford/);
  app.select('norway');
  assertUpcoming(app, 'Portugal', 1);
  app.select('all');
  assertUpcoming(app, 'Portugal', 1);
});

test('the entire schedule can expire without inventing recent results', () => {
  const app = loadApp('2026-09-04T09:00:00Z');
  const recent = app.markup('recent-list');
  const goals = app.text('latest-goals');
  app.setTime('2026-10-04T18:44:59Z');
  app.tick();
  assertUpcoming(app, 'Portugal', 1);
  app.setTime('2026-10-04T18:45:00Z');
  app.tick();
  assert.equal(app.text('next-match-title'), 'No upcoming matches');
  assert.equal(app.text('countdown'), 'Waiting for schedule updates');
  assert.equal(app.text('upcoming-count'), '0');
  assert.equal(fixtureCount(app), 0);
  assert.equal(app.markup('recent-list'), recent);
  assert.equal(app.text('recent-count'), '6');
  assert.equal(app.text('latest-goals'), goals);
  app.tick();
  assert.equal(app.text('countdown'), 'Waiting for schedule updates');
});

test('returning to a visible tab refreshes after timers were suspended', () => {
  const app = loadApp('2026-09-05T13:59:59Z');
  app.visibility('hidden');
  app.setTime('2026-09-06T09:00:00Z');
  app.visibility('visible');
  assertUpcoming(app, 'Man United', 7);
});

test('restoring a page refreshes after several fixtures have elapsed', () => {
  const app = loadApp('2026-09-05T13:59:59Z');
  app.setTime('2026-09-21T09:00:00Z');
  app.pageshow();
  assertUpcoming(app, 'Denmark', 4);
});
