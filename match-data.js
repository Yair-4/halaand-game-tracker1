(function (root) {
  'use strict';

  const CACHE_KEY = 'haaland-match-data-v1';
  const TEAM_IDS = {city: '382', norway: '464'};
  const TEAM_KEYS = Object.keys(TEAM_IDS);
  const API = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/';
  const BAD_STATUS = /CANCEL|POSTPON|ABANDON|SUSPEND|DELAY/i;
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const isText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
  const isScore = value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
  const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  const isSlug = value => typeof value === 'string' && /^[a-z0-9._-]{1,80}$/.test(value);

  function safeSource(value) {
    if (!isText(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch (_) { return false; }
  }

  function normalizeSchedule(payload, teamKey, kind = 'fixtures') {
    if (!Object.hasOwn(TEAM_IDS, teamKey) || !['fixtures', 'results'].includes(kind)) {
      throw new Error('Unknown team or schedule kind');
    }
    if (!isObject(payload) || !Array.isArray(payload.events) ||
        (payload.status !== undefined && payload.status !== 'success') ||
        (payload.team !== undefined && String(payload.team?.id) !== TEAM_IDS[teamKey])) {
      throw new Error('Invalid schedule response');
    }

    const matches = [];
    const seen = new Set();
    for (const event of payload.events) {
      if (!isObject(event) || !Array.isArray(event.competitions) || !event.competitions.length) {
        throw new Error('Invalid schedule event');
      }
      for (const competition of event.competitions) {
        const status = competition?.status?.type || event.status?.type;
        if (!isObject(status) || !['pre', 'in', 'post'].includes(status.state)) {
          throw new Error('Missing match status');
        }
        if (BAD_STATUS.test(`${status.name || ''} ${status.description || ''}`)) continue;
        if (kind === 'results' ? status.state !== 'post' || status.completed !== true
          : status.state !== 'pre' || status.completed === true) continue;

        const competitors = competition.competitors;
        if (!Array.isArray(competitors) || competitors.length !== 2) throw new Error('Invalid match teams');
        const home = competitors.find(item => item.homeAway === 'home');
        const away = competitors.find(item => item.homeAway === 'away');
        if (!home || !away || !isText(home.team?.displayName) || !isText(away.team?.displayName)) {
          throw new Error('Missing home or away team');
        }
        const homeId = String(home.team.id);
        const awayId = String(away.team.id);
        if ((homeId === TEAM_IDS[teamKey]) === (awayId === TEAM_IDS[teamKey])) {
          throw new Error('Schedule contains a different team');
        }
        const id = String(event.id || competition.id || '');
        const kickoff = competition.date || event.date;
        const league = event.league?.shortName || event.league?.name || event.league?.abbreviation;
        if (!/^\d+$/.test(id) || !isDate(kickoff) || !isText(league)) throw new Error('Missing match details');
        if (seen.has(id)) continue;
        seen.add(id);
        const match = {
          id, team: teamKey, kickoff: new Date(kickoff).toISOString(), competition: league,
          home: home.team.displayName, away: away.team.displayName,
          venue: isText(competition.venue?.fullName) ? competition.venue.fullName : 'Venue TBC',
          source: `https://www.espn.com/soccer/match/_/gameId/${id}`,
          timeConfirmed: event.timeValid !== false && competition.timeValid !== false,
          leagueSlug: isSlug(event.league?.slug) ? event.league.slug : null
        };
        if (kind === 'results') {
          const homeScore = isObject(home.score) ? home.score.value : home.score;
          const awayScore = isObject(away.score) ? away.score.value : away.score;
          if (!isScore(homeScore) || !isScore(awayScore)) throw new Error('Missing final score');
          const tracked = homeId === TEAM_IDS[teamKey] ? home : away;
          const opponent = tracked === home ? away : home;
          const trackedScore = tracked === home ? homeScore : awayScore;
          const opponentScore = tracked === home ? awayScore : homeScore;
          Object.assign(match, {homeScore, awayScore, haalandGoals: null,
            outcome: tracked.winner === true ? 'win' : opponent.winner === true ? 'loss'
              : trackedScore > opponentScore ? 'win' : trackedScore < opponentScore ? 'loss' : 'draw'});
        }
        matches.push(match);
      }
    }
    return matches.sort((a, b) => kind === 'fixtures'
      ? Date.parse(a.kickoff) - Date.parse(b.kickoff) : Date.parse(b.kickoff) - Date.parse(a.kickoff));
  }

  function copyMatches(matches, kind, allowLegacy = false) {
    if (!Array.isArray(matches)) throw new Error('Invalid saved matches');
    return matches.map(match => {
      if (!isObject(match) || !Object.hasOwn(TEAM_IDS, match.team) ||
          !['id', 'competition', 'home', 'away', 'venue'].every(key => isText(match[key])) ||
          !isDate(match.kickoff) || !safeSource(match.source) ||
          (!allowLegacy && typeof match.timeConfirmed !== 'boolean') ||
          (match.leagueSlug != null && !isSlug(match.leagueSlug))) throw new Error('Invalid saved match');
      const copy = {
        id: match.id, team: match.team, kickoff: new Date(match.kickoff).toISOString(),
        competition: match.competition, home: match.home, away: match.away, venue: match.venue,
        source: match.source, timeConfirmed: match.timeConfirmed !== false, leagueSlug: match.leagueSlug || null
      };
      if (kind === 'results') {
        if (!isScore(match.homeScore) || !isScore(match.awayScore) ||
            (match.haalandGoals !== null && !isScore(match.haalandGoals)) ||
            (match.outcome !== undefined && !['win', 'loss', 'draw'].includes(match.outcome))) {
          throw new Error('Invalid saved result');
        }
        Object.assign(copy, {homeScore: match.homeScore, awayScore: match.awayScore, haalandGoals: match.haalandGoals});
        if (match.outcome !== undefined) copy.outcome = match.outcome;
      }
      return copy;
    });
  }

  function createClient(options = {}) {
    const fallback = options.fallback || {upcoming: [], recent: [], updatedAt: '2026-08-29T00:00:00Z'};
    const now = options.now || Date.now;
    const fetcher = options.fetcher || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    let storage;
    try { storage = options.storage === undefined ? root.localStorage : options.storage; } catch (_) { storage = null; }
    if (!isDate(fallback.updatedAt)) throw new Error('Invalid fallback timestamp');

    const fallbackUpcoming = copyMatches(fallback.upcoming, 'fixtures', true);
    const fallbackRecent = copyMatches(fallback.recent, 'results', true);
    let state = {
      upcoming: fallbackUpcoming,
      recent: fallbackRecent,
      teams: Object.fromEntries(TEAM_KEYS.map(key => [key, {
        updatedAt: fallback.updatedAt,
        live: false,
        source: 'fallback'
      }])),
      loading: false,
      failedTeams: [],
      cachedTeams: []
    };

    // Cache is intentionally lazy: it is not read or displayed until a live
    // request for a team fails. This keeps the network source authoritative.
    let cacheLoaded = false;
    let cacheByTeam = Object.create(null);

    function loadCache() {
      if (cacheLoaded) return cacheByTeam;
      cacheLoaded = true;
      try {
        const saved = JSON.parse(storage?.getItem(CACHE_KEY) || 'null');
        if (!saved) return cacheByTeam;

        if (saved.version === 2 && isObject(saved.teams)) {
          for (const teamKey of TEAM_KEYS) {
            const team = saved.teams[teamKey];
            if (!isObject(team) || !isDate(team.updatedAt)) continue;
            const upcoming = copyMatches(team.upcoming, 'fixtures').filter(match => match.team === teamKey);
            const recent = copyMatches(team.recent, 'results').filter(match => match.team === teamKey);
            if (upcoming.length !== team.upcoming.length || recent.length !== team.recent.length) continue;
            cacheByTeam[teamKey] = {updatedAt: team.updatedAt, upcoming, recent};
          }
          return cacheByTeam;
        }

        // Backward compatibility with the previous single-payload cache.
        if (saved.version === 1 && Array.isArray(saved.upcoming) && Array.isArray(saved.recent) && isObject(saved.teams)) {
          const upcoming = copyMatches(saved.upcoming, 'fixtures');
          const recent = copyMatches(saved.recent, 'results');
          for (const teamKey of TEAM_KEYS) {
            if (!isDate(saved.teams?.[teamKey]?.updatedAt)) continue;
            cacheByTeam[teamKey] = {
              updatedAt: saved.teams[teamKey].updatedAt,
              upcoming: upcoming.filter(match => match.team === teamKey),
              recent: recent.filter(match => match.team === teamKey)
            };
          }
        }
      } catch (_) {
        cacheByTeam = Object.create(null);
      }
      return cacheByTeam;
    }

    function getState() {
      return {
        upcoming: state.upcoming.map(match => ({...match})),
        recent: state.recent.map(match => ({...match})),
        teams: Object.fromEntries(TEAM_KEYS.map(key => [key, {...state.teams[key]}])),
        loading: state.loading,
        failedTeams: [...state.failedTeams],
        cachedTeams: [...state.cachedTeams]
      };
    }

    async function fetchJSON(url, timeoutMs = 12000) {
      if (!fetcher) throw new Error('Network unavailable');
      const controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => fetcher(url, {
            cache: 'no-store', credentials: 'omit', ...(controller ? {signal: controller.signal} : {})
          })).then(response => {
            if (!response?.ok) throw new Error('Source request failed');
            return response.json();
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller?.abort();
              reject(new Error('Source request timed out'));
            }, timeoutMs);
          })
        ]);
      } finally { clearTimeout(timer); }
    }

    function replaceTeamData(teamKey, upcoming, recent) {
      state.upcoming = state.upcoming.filter(match => match.team !== teamKey).concat(upcoming);
      state.recent = state.recent.filter(match => match.team !== teamKey).concat(recent);
    }

    function useCacheAfterFailure(teamKey) {
      const cached = loadCache()[teamKey];
      if (!cached) {
        // If this session already had a successful live fetch, keep that data in
        // memory rather than downgrading to the bundled fallback.
        if (state.teams[teamKey].source === 'live') {
          state.teams[teamKey] = {...state.teams[teamKey], live: false, source: 'memory'};
        } else {
          state.teams[teamKey] = {...state.teams[teamKey], live: false, source: 'fallback'};
        }
        return false;
      }
      replaceTeamData(teamKey, cached.upcoming, cached.recent);
      state.teams[teamKey] = {updatedAt: cached.updatedAt, live: false, source: 'cache'};
      return true;
    }

    function writeCache(successfulTeams) {
      if (!storage || successfulTeams.length === 0) return;
      const teams = {};
      const previous = successfulTeams.length === TEAM_KEYS.length ? Object.create(null) : loadCache();
      for (const teamKey of TEAM_KEYS) {
        if (successfulTeams.includes(teamKey)) {
          teams[teamKey] = {
            updatedAt: state.teams[teamKey].updatedAt,
            upcoming: state.upcoming.filter(match => match.team === teamKey),
            recent: state.recent.filter(match => match.team === teamKey)
          };
        } else if (previous[teamKey]) {
          teams[teamKey] = previous[teamKey];
        }
      }
      try {
        storage.setItem(CACHE_KEY, JSON.stringify({version: 2, teams}));
        // Keep the in-memory copy aligned with what was just persisted.
        cacheLoaded = true;
        cacheByTeam = Object.fromEntries(Object.entries(teams).map(([key, value]) => [key, {
          updatedAt: value.updatedAt,
          upcoming: value.upcoming.map(match => ({...match})),
          recent: value.recent.map(match => ({...match}))
        }]));
      } catch (_) { /* Private browsing and a full cache do not affect fresh results. */ }
    }

    async function updateTeam(teamKey) {
      const url = `${API}all/teams/${TEAM_IDS[teamKey]}/schedule?region=us&lang=en&contentorigin=espn`;
      const [fixtures, results] = await Promise.all([fetchJSON(`${url}&fixture=true`), fetchJSON(url)]);
      const upcoming = normalizeSchedule(fixtures, teamKey, 'fixtures');
      const recent = normalizeSchedule(results, teamKey, 'results');

      // Retain already verified goal counts from the currently displayed data
      // while the match identity and final score still agree.
      for (const match of recent) {
        const previous = state.recent.find(item => item.team === teamKey && item.id === match.id &&
          item.home === match.home && item.away === match.away && item.kickoff === match.kickoff &&
          item.homeScore === match.homeScore && item.awayScore === match.awayScore);
        if (previous && isScore(previous.haalandGoals)) match.haalandGoals = previous.haalandGoals;
      }

      const latest = recent[0];
      if (latest?.leagueSlug) {
        try {
          const summary = await fetchJSON(`${API}${latest.leagueSlug}/summary?contentorigin=espn&event=${latest.id}&lang=en&region=us`, 6000);
          const summaryMatch = summary.header?.competitions?.find(match => String(match.id) === latest.id);
          if (summaryMatch?.status?.type?.completed === true && Array.isArray(summary.rosters)) {
            const athlete = summary.rosters.flatMap(roster => Array.isArray(roster.roster) ? roster.roster : [])
              .find(entry => String(entry.athlete?.id) === '253989');
            const goals = athlete?.stats?.find(stat => stat.name === 'totalGoals')?.value;
            if (isScore(goals)) latest.haalandGoals = goals;
          }
        } catch (_) { /* Player statistics are optional; schedules and scores remain usable. */ }
      }

      const updatedAt = new Date(now()).toISOString();
      replaceTeamData(teamKey, upcoming, recent);
      state.teams[teamKey] = {updatedAt, live: true, source: 'live'};
    }

    let pending = null;
    function refresh() {
      if (pending) return pending;
      state.loading = true;
      state.failedTeams = [];
      state.cachedTeams = [];

      const successfulTeams = [];
      pending = Promise.all(TEAM_KEYS.map(async teamKey => {
        try {
          await updateTeam(teamKey);
          successfulTeams.push(teamKey);
        } catch (_) {
          state.failedTeams.push(teamKey);
          if (useCacheAfterFailure(teamKey)) state.cachedTeams.push(teamKey);
        }
      })).then(() => {
        state.loading = false;
        state.failedTeams.sort();
        state.cachedTeams.sort();
        successfulTeams.sort();
        writeCache(successfulTeams);
        return getState();
      }).finally(() => { pending = null; });
      return pending;
    }

    return {getState, refresh};
  }

  const exported = {createClient, normalizeSchedule, CACHE_KEY};
  root.MatchData = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(globalThis);
