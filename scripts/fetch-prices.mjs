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
  const items = (data.core && data.core.items) || {};
  return (data.lines || []).map((line) => ({
    id: line.id,
    name: (items[line.id] && items[line.id].name) || String(line.id),
    value: line.primaryValue,
    unit: primary,
    changePct: computeChange(line.sparkline),
    icon: (items[line.id] && items[line.id].icon) || ''
  }));
}

async function main() {
  const leagues = await getJSON(LEAGUES_URL);
  if (!Array.isArray(leagues) || !leagues.length) {
    throw new Error('Leagues endpoint returned no leagues');
  }
  const league = leagues[0]; // first entry is the current temporary challenge league
  const leagueId = league.id;

  let lines = [];
  let source = '';

  try {
    const data = await getJSON(EXCHANGE_URL + '?league=' + encodeURIComponent(leagueId) + '&type=Currency');
    if (data.lines && data.lines.length) {
      lines = normalizeExchangeShape(data);
      source = 'exchange';
    } else {
      throw new Error('empty exchange response');
    }
  } catch (e1) {
    console.warn('Exchange overview failed, falling back to stash overview:', e1.message);
    try {
      const data2 = await getJSON(STASH_CURRENCY_URL + '?league=' + encodeURIComponent(leagueId) + '&type=Currency');
      lines = normalizeLegacyShape(data2);
      source = 'stash';
    } catch (e2) {
      console.warn('Stash overview failed, falling back to legacy endpoint:', e2.message);
      const data3 = await getJSON(LEGACY_URL + '?league=' + encodeURIComponent(leagueId) + '&type=Currency');
      lines = normalizeLegacyShape(data3);
      source = 'legacy';
    }
  }

  const output = {
    league: { id: leagueId, name: league.name || leagueId },
    source,
    fetchedAt: new Date().toISOString(),
    lines
  };

  const fs = await import('node:fs/promises');
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/currency.json', JSON.stringify(output, null, 2));
  console.log('Wrote data/currency.json:', lines.length, 'lines from', source, 'for league', league.name || leagueId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
