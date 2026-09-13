// Fetches boss drop tables from the Path of Exile Wiki's Cargo database
// and writes a normalized snapshot to data/loot.json. Runs server-side via
// GitHub Actions on a much slower schedule than the price fetcher, since
// this data barely changes between runs.

const API_BASE = 'https://www.poewiki.net/w/api.php';

const USER_AGENT = 'poe-companion/1.0 (personal project, github.com/Seanathustra/poe-companion)';

const fsp = await import('node:fs/promises');

// Curated V1 list. Add a name here to track a new boss, no id hunting
// needed, resolveMonsterIds() looks up the wiki's own id for us.
const BOSSES = [
  'Sirus, Awakener of Worlds',
  'The Maven',
  'The Shaper',
  'The Elder',
  'The Eater of Worlds',
  'The Searing Exarch',
  'Baran, the Crusader',
  'Veritania, the Redeemer',
  'Al-Hezmin, the Hunter',
  'Drox, the Warlord'
  // 'The Feared' deliberately excluded: it's an encounter name (the four
  // Conquerors fought together in Ultimatum), not a distinct monster
  // entity with its own drop_monsters link. Its rewards are likely
  // tracked via a different, Ultimatum-specific system on the wiki.
  // Worth its own investigation later, not a fit for this simple pattern.
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
  // tiers, phases, apparitions). We collect all of them and match drops
  // against any. Match against monsters.name (the display name), not
  // _pageName, which points to the monster's own technical wiki page
  // (e.g. "Monster:Metadata/Monsters/...") rather than the boss's name.
  //
  // Every field is explicitly aliased: Cargo returns unaliased
  // underscore-containing field names with a space instead of an
  // underscore in the JSON (e.g. "metadata id"), which silently breaks
  // plain dot-access in JS unless we rename them ourselves.
  const params = {
    tables: 'monsters',
    fields: 'monsters.metadata_id=metadataId,monsters.name=name',
    where: 'monsters.name LIKE "%' + bossName.replace(/"/g, '\\"') + '%"',
    limit: '20'
  };
  const rows = await cargoQuery(params);
  if (!rows.length) {
    const debugUrl = API_BASE + '?' + new URLSearchParams({ action: 'cargoquery', format: 'json', ...params }).toString();
    console.warn('  Zero rows for "' + bossName + '". Inspect this URL directly: ' + debugUrl);
  }
  return [...new Set(rows.map((r) => r.metadataId).filter(Boolean))];
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
};

function decodeEntities(str) {
  if (!str) return str;
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent) ? NAMED_ENTITIES[ent] : match;
  });
}

const iconCache = new Map(); // item name -> local relative path or null

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function downloadIcon(name) {
  if (iconCache.has(name)) return iconCache.get(name);

  const remoteUrl = 'https://www.poewiki.net/wiki/Special:FilePath/' + encodeURIComponent(name + ' inventory icon.png');
  const localPath = 'data/icons/' + slugify(name) + '.png';

  try {
    const res = await fetch(remoteUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error('Not an image (got ' + contentType + ')');
    const buffer = Buffer.from(await res.arrayBuffer());
    await fsp.mkdir('data/icons', { recursive: true });
    await fsp.writeFile(localPath, buffer);
    iconCache.set(name, './' + localPath);
    return './' + localPath;
  } catch (err) {
    console.warn('  Icon download failed for "' + name + '":', err.message);
    iconCache.set(name, null);
    return null;
  }
}

async function fetchDropsForIds(ids) {
  if (!ids.length) return [];
  // The wiki's HOLDS operator (meant for querying list fields like
  // drop_monsters) is documented as buggy on this wiki. The working
  // pattern is a LIKE against the __full variant of the field instead.
  const likeClauses = ids.map((id) => 'items.drop_monsters__full LIKE "%' + id + '%"').join(' OR ');
  const rows = await cargoQuery({
    tables: 'items',
    fields: 'items.name,items._pageName=pageName,items.rarity_id=rarityId,items.class_id=classId',
    where: likeClauses,
    limit: '500'
  });
  // De-dupe by page name, a monster with multiple ids can otherwise
  // return the same item once per matching id.
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const name = decodeEntities(row.name);
    const pageName = decodeEntities(row.pageName);
    const key = pageName || name;
    if (seen.has(key)) continue;
    seen.add(key);
    // Downloaded once per unique item name and committed locally, rather
    // than hotlinked at view time: the wiki's asset server appears to
    // block cross-site embedded image requests (likely anti-bot
    // protection that doesn't carry over to embeds), but plain
    // server-side fetches like this one go through fine.
    const iconPath = await downloadIcon(name);
    items.push({
      name: name,
      pageName: pageName,
      rarity: row.rarityId || null,
      itemClass: row.classId || null,
      iconUrl: iconPath,
      wikiUrl: 'https://www.poewiki.net/wiki/' + encodeURIComponent((pageName || name).replace(/ /g, '_'))
    });
  }
  return items;
}

async function main() {
  const bossResults = [];

  for (const bossName of BOSSES) {
    let ids;
    try {
      ids = await resolveMonsterIds(bossName);
    } catch (err) {
      console.warn('[' + bossName + '] Failed to resolve monster id(s):', err.message);
      continue;
    }
    if (!ids.length) {
      console.warn('No monster id found for "' + bossName + '", skipping. Check the exact wiki page name.');
      continue;
    }
    try {
      const items = await fetchDropsForIds(ids);
      bossResults.push({ name: bossName, monsterIds: ids, items });
      console.log('Resolved "' + bossName + '" -> ' + ids.length + ' id(s), ' + items.length + ' item(s)');
    } catch (err) {
      console.warn('[' + bossName + '] Resolved id(s) ' + ids.join(', ') + ' but failed to fetch drops:', err.message);
    }
  }

  if (!bossResults.length) {
    throw new Error('Every boss failed to resolve, nothing to write');
  }

  const output = {
    generatedAt: new Date().toISOString(),
    bosses: bossResults
  };

  const fs = fsp;
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/loot.json', JSON.stringify(output, null, 2));
  console.log('Wrote data/loot.json covering', bossResults.length, 'bosses');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
