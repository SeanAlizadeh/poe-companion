// Fetches current-league currency prices from poe.ninja and writes a
// normalized snapshot to data/currency.json. Runs server-side via GitHub
// Actions, so there's no browser CORS restriction to work around.

const LEAGUES_URL = 'https://poe.ninja/poe1/api/economy/leagues';
const EXCHANGE_URL = 'https://poe.ninja/poe1/api/economy/exchange/current/overview';
const STASH_CURRENCY_URL = 'https://poe.ninja/poe1/api/economy/stash/current/currency/overview';
const LEGACY_URL = 'https://poe.ninja/api/data/currencyoverview';

// poe.ninja's docs ask clients to send a descriptive User-Agent identifying
// the app and a contact, so a scheduled job (rather than raw per-user
// browser traffic) can do that properly.
const USER_AGENT = 'poe-companion/1.0 (personal project, github.com/SeanAlizadeh/poe-companion)';

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}

function computeChange(sparkline) {
  if (!sparkline || !sparkline.data) return null;
  const points = sparkline.data.filter((v) => v !== null && v !== undefined);
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first) return null;
  return ((last - first) / first) * 100;
}

function normalizeLegacyShape(data) {
  const details = data.currencyDetails || [];
  return (data.lines || []).map((line) => ({
    id: line.currencyTypeName,
    name: line.currencyTypeName,
    value: line.chaosEquivalent,
    unit: 'chaos',
    changePct: computeChange(line.receiveSparkLine),
    icon: (details.find((d) => d.name === line.currencyTypeName) || {}).icon || ''
  }));
}

function normalizeExchangeShape(data) {
  const primary = (data.core && data.core.primary) || 'chaos';
  const itemsArray = (data.core && data.core.items) || [];
  const itemsById = {};
  itemsArray.forEach((it) => { itemsById[it.id] = it; });
  return (data.lines || []).map((line) => ({
    id: line.id,
    name: (itemsById[line.id] && itemsById[line.id].name) || String(line.id),
    value: line.primaryValue,
    unit: primary,
    changePct: computeChange(line.sparkline),
    icon: (itemsById[line.id] && itemsById[line.id].icon) || ''
  }));
}

function addDivineValues(lines) {
  const divine = lines.find((l) => l.name && l.name.toLowerCase() === 'divine orb');
  const chaosPerDivine = divine ? divine.value : null;
  return lines.map((l) => ({
    ...l,
    divineValue: chaosPerDivine ? l.value / chaosPerDivine : null
  }));
}

async function fetchLeagueLines(leagueId) {
  let lines, source;
  try {
    const data = await getJSON(EXCHANGE_URL + '?league=' + encodeURIComponent(leagueId) + '&type=Currency');
    if (data.lines && data.lines.length) {
      lines = normalizeExchangeShape(data);
      source = 'exchange';
    } else {
      throw new Error('empty exchange response');
    }
  } catch (e1) {
    console.warn('[' + leagueId + '] Exchange overview failed, falling back to stash overview:', e1.message);
    try {
      const data2 = await getJSON(STASH_CURRENCY_URL + '?league=' + encodeURIComponent(leagueId) + '&type=Currency');
      lines = normalizeLegacyShape(data2);
      source = 'stash';
    } catch (e2) {
      console.warn('[' + leagueId + '] Stash overview failed, falling back to legacy endpoint:', e2.message);
      const data3 = await getJSON(LEGACY_URL + '?league=' + encodeURIComponent(leagueId) + '&type=Currency');
      lines = normalizeLegacyShape(data3);
      source = 'legacy';
    }
  }
  return { lines: addDivineValues(lines), source };
}

async function main() {
  const leagues = await getJSON(LEAGUES_URL);
  if (!Array.isArray(leagues) || !leagues.length) {
    throw new Error('Leagues endpoint returned no leagues');
  }

  const leagueSummaries = [];
  const dataByLeague = {};

  // Fetch every league the endpoint lists (typically the current challenge
  // league, its hardcore variant, Standard, and Hardcore). One at a time to
  // stay polite to poe.ninja rather than firing requests in parallel.
  for (const league of leagues) {
    try {
      const { lines, source } = await fetchLeagueLines(league.id);
      leagueSummaries.push({ id: league.id, name: league.name || league.id });
      dataByLeague[league.id] = { source, lines };
      console.log('Fetched', lines.length, 'lines for', league.name || league.id, 'via', source);
    } catch (err) {
      console.warn('Skipping league', league.id, 'entirely, all sources failed:', err.message);
    }
  }

  if (!leagueSummaries.length) {
    throw new Error('Every league failed to fetch, nothing to write');
  }

  const output = {
    leagues: leagueSummaries,
    defaultLeague: leagueSummaries[0].id, // first entry is the current temporary challenge league
    fetchedAt: new Date().toISOString(),
    data: dataByLeague
  };

  const fs = await import('node:fs/promises');
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/currency.json', JSON.stringify(output, null, 2));
  console.log('Wrote data/currency.json covering', leagueSummaries.length, 'leagues');

  // TEMPORARY DEBUG: dump the raw, untouched exchange overview response for
  // the default league so we can see poe.ninja's real field names directly,
  // instead of guessing from secondhand write-ups. Safe to delete once the
  // icon lookup is confirmed correct.
  try {
    const rawUrl = EXCHANGE_URL + '?league=' + encodeURIComponent(leagueSummaries[0].id) + '&type=Currency';
    const raw = await getJSON(rawUrl);
    const sample = {
      topLevelKeys: Object.keys(raw),
      coreKeys: raw.core ? Object.keys(raw.core) : null,
      firstTwoLines: (raw.lines || []).slice(0, 2),
      itemsIsArray: Array.isArray(raw.core && raw.core.items),
      itemsSample: raw.core && Array.isArray(raw.core.items)
        ? raw.core.items.slice(0, 2)
        : (raw.core && raw.core.items ? Object.entries(raw.core.items).slice(0, 2) : null),
      topLevelItemsSample: raw.items ? (Array.isArray(raw.items) ? raw.items.slice(0, 2) : Object.entries(raw.items).slice(0, 2)) : null
    };
    await fs.writeFile('data/debug-raw.json', JSON.stringify(sample, null, 2));
    console.log('Wrote data/debug-raw.json for inspection');
  } catch (debugErr) {
    console.warn('Debug dump failed (non-fatal):', debugErr.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
