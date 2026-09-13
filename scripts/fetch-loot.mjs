// Fetches boss drop tables from the Path of Exile Wiki's Cargo database
// and writes a normalized snapshot to data/loot.json. Runs server-side via
// GitHub Actions on a much slower schedule than the price fetcher, since
// this data barely changes between runs.

const API_BASE = 'https://www.poewiki.net/api.php';

const USER_AGENT = 'poe-companion/1.0 (personal project, github.com/Seanathustra/poe-companion)';

// Curated V1 list. Add a name here to track a new boss, no id hunting
// needed, resolveMonsterIds() looks up the wiki's own id for us.
const BOSSES = [
  'Sirus, Awakener of Worlds',
  'The Maven',
  'The Shaper',
  'The Elder',
  'The Eater of Worlds',
  'The Searing Exarch',
  'The Feared',
  'Baran, the Crusader',
  'Veritania, the Redeemer',
  'Al-Hezmin, the Hunter',
  'Drox, the Warlord'
];

async function cargoQuery(params) {
  const url = API_BASE + '?' + new URLSearchParams({
    action: 'cargoquery',
    format: 'json',
    ...params
  }).toString();

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const json = await res.json();
  if (json.error) throw new Error('Cargo error: ' + JSON.stringify(json.error));
  return (json.cargoquery || []).map((r) => r.title);
}

async function resolveMonsterIds(bossName) {
  // A boss can have more than one underlying monster id (difficulty
  // tiers, phases). We collect all of them and match drops against any.
  const rows = await cargoQuery({
    tables: 'monsters',
    fields: 'monsters.metadata_id,monsters._pageName',
    where: 'monsters._pageName="' + bossName.replace(/"/g, '\\"') + '"',
    limit: '20'
  });
  return [...new Set(rows.map((r) => r.metadata_id).filter(Boolean))];
}

async function fetchDropsForIds(ids) {
  if (!ids.length) return [];
  // The wiki's HOLDS operator (meant for querying list fields like
  // drop_monsters) is documented as buggy on this wiki. The working
  // pattern is a LIKE against the __full variant of the field instead.
  const likeClauses = ids.map((id) => 'items.drop_monsters__full LIKE "%' + id + '%"').join(' OR ');
  const rows = await cargoQuery({
    tables: 'items',
    fields: 'items.name,items._pageName,items.rarity_id',
    where: likeClauses,
    limit: '500'
  });
  // De-dupe by page name, a monster with multiple ids can otherwise
  // return the same item once per matching id.
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const key = row._pageName || row.name;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      name: row.name,
      pageName: row._pageName,
      rarity: row.rarity_id || null,
      wikiUrl: 'https://www.poewiki.net/wiki/' + encodeURIComponent((row._pageName || row.name).replace(/ /g, '_'))
    });
  }
  return items;
}

async function main() {
  const bossResults = [];

  for (const bossName of BOSSES) {
    try {
      const ids = await resolveMonsterIds(bossName);
      if (!ids.length) {
        console.warn('No monster id found for "' + bossName + '", skipping. Check the exact wiki page name.');
        continue;
      }
      const items = await fetchDropsForIds(ids);
      bossResults.push({ name: bossName, monsterIds: ids, items });
      console.log('Resolved "' + bossName + '" -> ' + ids.length + ' id(s), ' + items.length + ' item(s)');
    } catch (err) {
      console.warn('Failed to fetch drops for "' + bossName + '":', err.message);
    }
  }

  if (!bossResults.length) {
    throw new Error('Every boss failed to resolve, nothing to write');
  }

  const output = {
    generatedAt: new Date().toISOString(),
    bosses: bossResults
  };

  const fs = await import('node:fs/promises');
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/loot.json', JSON.stringify(output, null, 2));
  console.log('Wrote data/loot.json covering', bossResults.length, 'bosses');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
