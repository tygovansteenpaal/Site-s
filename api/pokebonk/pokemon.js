// PokéBonk farms: the game's public species list (names, types, generation), slimmed down and
// cached at the edge for a day.
module.exports = async function handler(req, res) {
  try {
    const all = await (await fetch('https://pokebonk.com/data/pokemon.json')).json();
    const slim = all.map((p) => ({ id: p.id, name: p.name, types: p.types, gen: p.gen, family: p.family,
      evoStage: p.evoStage, legendary: p.legendary, mythical: p.mythical }));
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.status(200).json(slim);
  } catch {
    res.status(502).json([]);
  }
};
