const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const MatchData = require('../match-data.js');

const INITIAL_TIME = '2026-08-29T00:00:00Z';
const CURRENT_TIME = '2026-09-06T10:30:00.000Z';
const TEAM_IDS = { city: '382', norway: '464' };
const TEAM_NAMES = { city: 'Manchester City', norway: 'Norway' };

// These small fixtures preserve ESPN schedule envelopes and competition/score
// shapes, without requiring a network connection or downloaded sample files.
function event(team = 'city', kind = 'fixtures', options = {}) {
  const id = options.id || (team === 'city' ? '900001' : '900002');
  const date = options.date || (kind === 'results' ? '2026-09-05T14:00Z' : '2026-09-13T15:30Z');
  const trackedAtHome = options.trackedAtHome !== false;
  const competitors = ['home', 'away'].map((homeAway, index) => {
    const tracked = (homeAway === 'home') === trackedAtHome;
    const teamId = tracked ? TEAM_IDS[team] : '999';
    const displayName = tracked ? TEAM_NAMES[team] : 'Example Opponent';
    const competitor = { id: teamId, homeAway, type: 'team', team: { id: teamId, displayName } };
    if (kind === 'results') {
      const score = (options.scores || [1, 0])[index];
      if (score !== undefined) competitor.score = { value: score, displayValue: String(score) };
    }
    return competitor;
  });
  if (options.reverseCompetitors) competitors.reverse();
  const status = options.status || (kind === 'results'
    ? { name: 'STATUS_FULL_TIME', state: 'post', completed: true }
    : { name: 'STATUS_SCHEDULED', state: 'pre', completed: false });
  return {
    id,
    date,
    timeValid: options.timeValid !== false,
    league: { name: team === 'city' ? 'English Premier League' : 'UEFA Nations League' },
    competitions: [{
      id,
      date,
      timeValid: options.timeValid !== false,
      competitors,
      venue: { fullName: 'Example Stadium' },
      status: { type: status }
    }],
    links: [{ rel: ['summary', 'desktop', 'event'], href: 'https://untrusted.example/match' }]
  };
}

function feed(team = 'city', kind = 'fixtures', events = [event(team, kind)]) {
  return { status: 'success', timestamp: INITIAL_TIME, team: { id: TEAM_IDS[team] }, events };
}

function fallback() {
  const record = team => ({
    id: `old-${team}`,
    team,
    kickoff: '2026-08-28T19:00:00Z',
    home: TEAM_NAMES[team],
    away: 'Old Opponent',
    competition: 'Previous Competition',
    venue: 'Previous Stadium',
    source: 'https://www.espn.com/soccer/',
    timeConfirmed: true
  });
  return {
    upcoming: ['city', 'norway'].map(record),
    recent: ['city', 'norway'].map(team => ({
      ...record(team), id: `old-result-${team}`, homeScore: 2, awayScore: 1, haalandGoals: 1
    })),
    updatedAt: INITIAL_TIME
  };
}

function memoryStorage() {
  const entries = new Map();
  return {
    entries,
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); }
  };
}

function routingFetcher(overrides = {}) {
  const calls = [];
  const fetcher = async (input, options) => {
    const url = new URL(input);
    const team = Object.keys(TEAM_IDS).find(key => url.pathname.includes(`/teams/${TEAM_IDS[key]}/`));
    assert.ok(team, `Unexpected endpoint: ${url}`);
    assert.equal(url.hostname, 'site.web.api.espn.com');
    assert.match(url.pathname, /\/all\/teams\/(382|464)\/schedule$/);
    assert.equal(url.searchParams.get('region'), 'us');
    assert.equal(url.searchParams.get('lang'), 'en');
    assert.equal(url.searchParams.get('contentorigin'), 'espn');
    const kind = url.searchParams.get('fixture') === 'true' ? 'fixtures' : 'results';
    calls.push({ team, kind, options, url: String(url) });
    const override = overrides[`${team}-${kind}`];
    if (override instanceof Error) throw override;
    if (typeof override === 'function') return override(input, options);
    return { ok: true, json: async () => override === undefined ? feed(team, kind) : override };
  };
  return { fetcher, calls };
}

function makeClient(options = {}) {
  const router = routingFetcher(options.overrides);
  let time = Date.parse(CURRENT_TIME);
  const client = MatchData.createClient({
    fallback: fallback(),
    fetcher: options.fetcher || router.fetcher,
    storage: options.storage || memoryStorage(),
    now: () => time
  });
  return { client, calls: router.calls, setTime(iso) { time = Date.parse(iso); } };
}

test('the client is usable from CommonJS and a browser script', () => {
  assert.equal(typeof MatchData.createClient, 'function');
  assert.equal(typeof MatchData.normalizeSchedule, 'function');
  const browser = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'match-data.js'), 'utf8'), browser);
  assert.equal(typeof browser.MatchData.createClient, 'function');
  assert.equal(typeof browser.MatchData.normalizeSchedule, 'function');
});

test('normalization follows homeAway even when competitors arrive in reverse order', () => {
  const payload = feed('city', 'results', [event('city', 'results', {
    trackedAtHome: false, reverseCompetitors: true, scores: [0, 2]
  })]);
  const [result] = MatchData.normalizeSchedule(payload, 'city', 'results');
  assert.equal(result.team, 'city');
  assert.equal(result.home, 'Example Opponent');
  assert.equal(result.away, 'Manchester City');
  assert.equal(result.homeScore, 0);
  assert.equal(result.awayScore, 2);
  assert.equal(result.haalandGoals, null, 'a team score does not reveal Haaland’s goals');
  assert.equal(new URL(result.source).hostname, 'www.espn.com');
  assert.match(new URL(result.source).pathname, /\/soccer\/match\/_\/gameId\/900001/);
  assert.equal(Date.parse(result.kickoff), Date.parse('2026-09-05T14:00Z'));
});

test('provisional kickoff dates are retained without claiming a confirmed time', () => {
  const payload = feed('norway', 'fixtures', [event('norway', 'fixtures', { timeValid: false })]);
  const [fixture] = MatchData.normalizeSchedule(payload, 'norway', 'fixtures');
  assert.equal(fixture.timeConfirmed, false);
  assert.equal(fixture.team, 'norway');
  const confirmed = MatchData.normalizeSchedule(feed(), 'city', 'fixtures')[0];
  assert.equal(confirmed.timeConfirmed, true);
});

test('fixtures and results follow source status rather than inferring completion from the date', () => {
  const scheduledInPast = event('city', 'fixtures', { date: '2026-08-01T14:00Z' });
  const completed = event('city', 'results', { id: '900003' });
  const inProgress = event('city', 'results', {
    id: '900004', status: { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false }
  });
  const payload = feed('city', 'fixtures', [scheduledInPast, completed, inProgress]);
  const fixtures = MatchData.normalizeSchedule(payload, 'city', 'fixtures');
  const results = MatchData.normalizeSchedule(payload, 'city', 'results');
  assert.ok(fixtures.some(match => Date.parse(match.kickoff) === Date.parse(scheduledInPast.date)));
  assert.equal(results.length, 1);
  assert.match(results[0].source, /900003/);
  assert.ok(fixtures.every(match => !match.source.includes('900003')));
});

test('cancelled and postponed matches are excluded even when a status says completed', () => {
  for (const name of ['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_CANCELLED']) {
    const payload = feed('city', 'results', [event('city', 'results', {
      status: { name, state: 'post', completed: true }
    })]);
    assert.deepEqual(MatchData.normalizeSchedule(payload, 'city', 'results'), []);
    assert.deepEqual(MatchData.normalizeSchedule(payload, 'city', 'fixtures'), []);
  }
});

test('completed results require real numeric scores and never fabricate zero', () => {
  for (const missingScore of [undefined, null, '', 'not a score', -1]) {
    const payload = feed('city', 'results', [event('city', 'results', { scores: [missingScore, 1] })]);
    assert.throws(() => MatchData.normalizeSchedule(payload, 'city', 'results'));
  }
  const [zero] = MatchData.normalizeSchedule(feed('city', 'results', [event('city', 'results', {
    scores: [0, 0]
  })]), 'city', 'results');
  assert.equal(zero.homeScore, 0);
  assert.equal(zero.awayScore, 0);
});

test('malformed or wrong-team responses cannot masquerade as an empty schedule', () => {
  for (const payload of [null, {}, { events: {} }, { status: 'error', events: [] }, feed('norway')]) {
    assert.throws(() => MatchData.normalizeSchedule(payload, 'city', 'fixtures'));
  }
  const missingCompetitors = feed();
  missingCompetitors.events[0].competitions[0].competitors = [];
  assert.throws(() => MatchData.normalizeSchedule(missingCompetitors, 'city', 'fixtures'));
  const invalidDate = feed('city', 'fixtures', [event('city', 'fixtures', { date: 'unknown' })]);
  assert.throws(() => MatchData.normalizeSchedule(invalidDate, 'city', 'fixtures'));
  assert.deepEqual(MatchData.normalizeSchedule(feed('city', 'fixtures', []), 'city', 'fixtures'), []);
});

test('opening refresh replaces stale fixtures, results and timestamps for both teams', async () => {
  const { client, calls } = makeClient();
  const before = client.getState();
  assert.equal(before.loading, false);
  assert.equal(before.teams.city.updatedAt, INITIAL_TIME);
  assert.equal(before.teams.city.live, false);
  const request = client.refresh();
  assert.equal(client.getState().loading, true);
  const state = await request;
  assert.equal(state.loading, false);
  assert.deepEqual(state.failedTeams, []);
  assert.equal(state.upcoming.length, 2);
  assert.equal(state.recent.length, 2);
  assert.ok([...state.upcoming, ...state.recent].every(match => !match.id.startsWith('old-')));
  for (const team of ['city', 'norway']) {
    assert.equal(state.teams[team].updatedAt, CURRENT_TIME);
    assert.equal(state.teams[team].live, true);
  }
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map(call => `${call.team}-${call.kind}`)).size, 4);
  for (const { options } of calls) {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(typeof options.signal.addEventListener, 'function');
  }
});

test('overlapping entry events share requests but a later visit fetches again', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const router = routingFetcher();
  const { client, setTime } = makeClient({ fetcher: async (...args) => { await gate; return router.fetcher(...args); } });
  const first = client.refresh();
  const second = client.refresh();
  release();
  await Promise.all([first, second]);
  assert.equal(router.calls.length, 4);
  setTime('2026-09-06T11:30:00.000Z');
  const updated = await client.refresh();
  assert.equal(router.calls.length, 8);
  assert.equal(updated.teams.city.updatedAt, '2026-09-06T11:30:00.000Z');
});

test('one failed feed retains that team’s entire previous snapshot while the other team updates', async () => {
  const { client } = makeClient({ overrides: { 'city-results': new Error('Offline') } });
  const before = client.getState();
  const state = await client.refresh();
  assert.deepEqual(state.upcoming.filter(match => match.team === 'city'), before.upcoming.filter(match => match.team === 'city'));
  assert.deepEqual(state.recent.filter(match => match.team === 'city'), before.recent.filter(match => match.team === 'city'));
  assert.equal(state.teams.city.updatedAt, INITIAL_TIME);
  assert.equal(state.teams.city.live, false);
  assert.equal(state.teams.norway.updatedAt, CURRENT_TIME);
  assert.equal(state.teams.norway.live, true);
  assert.deepEqual(state.failedTeams, ['city']);
  assert.ok(state.upcoming.some(match => match.team === 'norway' && !match.id.startsWith('old-')));
});

test('invalid JSON, HTTP failure and malformed data all preserve the last verified snapshot', async () => {
  for (const brokenFeed of [
    async () => ({ ok: false, status: 503, json: async () => feed() }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('Bad JSON'); } }),
    { status: 'success', events: 'not an array' }
  ]) {
    const { client } = makeClient({ overrides: { 'city-fixtures': brokenFeed } });
    const before = client.getState();
    const state = await client.refresh();
    assert.deepEqual(state.upcoming.filter(match => match.team === 'city'), before.upcoming.filter(match => match.team === 'city'));
    assert.equal(state.teams.city.updatedAt, INITIAL_TIME);
    assert.deepEqual(state.failedTeams, ['city']);
  }
});

test('successful empty feeds clear obsolete matches instead of retaining stale fixtures', async () => {
  const { client } = makeClient({ overrides: {
    'city-fixtures': feed('city', 'fixtures', []),
    'city-results': feed('city', 'results', [])
  } });
  const state = await client.refresh();
  assert.equal(state.upcoming.filter(match => match.team === 'city').length, 0);
  assert.equal(state.recent.filter(match => match.team === 'city').length, 0);
  assert.equal(state.teams.city.updatedAt, CURRENT_TIME);
  assert.equal(state.teams.city.live, true);
});

test('a new client restores verified cached data and preserves it during an offline refresh', async () => {
  const storage = memoryStorage();
  const first = makeClient({ storage });
  const saved = await first.client.refresh();
  assert.ok(storage.entries.size > 0, 'successful source data must be cached');
  const next = makeClient({ storage, fetcher: async () => { throw new Error('Offline'); } });
  const restored = next.client.getState();
  assert.deepEqual(restored.upcoming, saved.upcoming);
  assert.deepEqual(restored.recent, saved.recent);
  assert.equal(restored.teams.city.updatedAt, CURRENT_TIME);
  assert.equal(restored.teams.city.live, false, 'cached data is not a fresh network result');
  const offline = await next.client.refresh();
  assert.deepEqual(offline.upcoming, saved.upcoming);
  assert.deepEqual(offline.recent, saved.recent);
  assert.equal(offline.teams.city.updatedAt, CURRENT_TIME);
  assert.deepEqual(new Set(offline.failedTeams), new Set(['city', 'norway']));
});

test('unreadable, invalid and malformed cached data safely fall back to the bundled snapshot', async () => {
  const storage = memoryStorage();
  await makeClient({ storage }).client.refresh();
  const [key, value] = [...storage.entries][0];
  const malformed = JSON.parse(value);
  malformed.upcoming[0].kickoff = 'not a date';
  for (const invalid of ['{bad json', JSON.stringify({ version: -1 }), JSON.stringify(malformed)]) {
    storage.entries.set(key, invalid);
    const state = makeClient({ storage }).client.getState();
    assert.deepEqual(state.upcoming, fallback().upcoming);
    assert.deepEqual(state.recent, fallback().recent);
    assert.equal(state.teams.city.updatedAt, INITIAL_TIME);
  }
});

test('storage exceptions do not prevent current source data from loading', async () => {
  const storage = {
    getItem() { throw new Error('Storage disabled'); },
    setItem() { throw new Error('Storage full'); }
  };
  const { client } = makeClient({ storage });
  const state = await client.refresh();
  assert.deepEqual(state.failedTeams, []);
  assert.equal(state.teams.city.updatedAt, CURRENT_TIME);
  assert.ok(state.recent.every(match => !match.id.startsWith('old-')));
});
