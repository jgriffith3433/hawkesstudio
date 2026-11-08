// How Studio plans a game (the game quality rubric's living-world rule, quality.ts; the owner, 2026-11-08: a game is a
// whole world, not a demo): before features, a game gets two roadmap items at the top of its roadmap:
//   1. World bible: docs/world-bible.md, the areas, landmarks, who lives there, what happens in each place and the story
//      beats as events, checked by the fun reviewer before any code builds on it;
//   2. Vertical slice: one area finished to the full bar (dressed, a landmark, life, ambient sound, several kinds of
//      interaction, a story beat told as an event), depending on the world bible, before the game widens.
// ensureFoundation adds them, once, when a game's roadmap gets its first item from planning (the roadmap API, Talk's
// studio_roadmap_edit) and the game has neither the items nor a world bible in its source. A new game's first version
// is planned the same way (repokit.ts firstVersionBrief).

import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.ts';
import { getProduct, PROJECTS } from './config.ts';
import { isGame } from './quality.ts';
import { BIBLE_SECTIONS } from './quality-scan.ts';

export const BIBLE_TITLE = 'World bible';
export const SLICE_TITLE = 'Vertical slice';

/** The template the world bible task and the game-quality skill give agents. */
export const BIBLE_TEMPLATE = `# <Game>: world bible

## Areas
Each area: its name, its mood, what it looks and sounds like, how big it is, how the player gets in and out.

## Landmarks
One landmark per area a player can see from far off and steer by.

## Who lives here
The characters and creatures, their routines through the day, and how they react to the player.

## What happens
Per area: the interactions (several kinds), the events that happen on their own, the ambient sound, what changes over time.

## Story beats
Each beat as an event the player lives through (gameplay, an in-game cutscene with real events, sound, voice lines), with
where and when it happens. On-screen text is a last resort, one line at most.
`;

export const bibleRequest = (name: string) => `Write ${name}'s world bible in docs/world-bible.md before more is built, so every agent builds one world, not a demo.

Read the story doc, AGENTS.md and what the game has now. Then write the bible with these sections (headings exactly):
${BIBLE_SECTIONS.map((s) => `- ${s}`).join('\n')}

Plan a full world: a player never walks more than about 10 seconds without something to see, hear or do; every area has
dressing, a landmark, life, ambient sound and several kinds of interaction; things move and change on their own; every
story beat is an event, a cutscene with real events, sound or a voice line, never text alone. Keep what already exists
and say where it falls short. Ask the fun-reviewer subagent to judge the bible and fix what it calls a demo. Change no
game code in this task. The template:

${BIBLE_TEMPLATE}`;

export const sliceRequest = (name: string) => `Build ${name}'s vertical slice: one area from docs/world-bible.md finished to the full bar before the game widens.

Pick the area the world bible marks as the start (or the first one). Finish it completely: dressed with no bare floors or
empty rooms, its landmark, characters with routines and reactions, ambient sound, several kinds of interaction, and one
story beat told as an event (gameplay, an in-game cutscene with real events, sound effects, a Hawkes Gen voice line), with
text as a last resort. Follow every game quality rule (the brief's "Game quality rules"). Extend the playtest scenario so
it walks the whole area and reports quality.maxQuietSeconds and quality.textOnlyBeats.`;

export const SLICE_CRITERIA = [
  'Walking the slice area, there is never more than about 10 seconds without something to see, hear or do',
  'The area has its landmark, characters that move on their own, ambient sound and at least three kinds of interaction',
  'Its story beat plays as an event with sound or voice, not as text alone',
  'The fun review calls the slice a living world, not a demo',
];
export const BIBLE_CRITERIA = [
  `docs/world-bible.md exists with every section: ${BIBLE_SECTIONS.join(', ')}`,
  'Every story beat in it is an event, a cutscene, sound or voice, with text as a last resort',
];

/** Whether the game's source already has a world bible (the server's checkout; unknown counts as no). */
function hasBible(productId: string) {
  try {
    const p = getProduct(productId);
    const dir = path.join(PROJECTS, p.repo);
    return ['docs/world-bible.md', 'world-bible.md'].some((f) => fs.existsSync(path.join(dir, f)));
  } catch {
    return false;
  }
}

/**
 * The world bible and vertical slice items at the top of a game's roadmap, added once. Returns the items it added
 * (none when the product isn't a game, already has them, or already has a world bible in its source).
 */
export async function ensureFoundation(productId: string, by = 'Studio'): Promise<{ added: string[] }> {
  let p;
  try { p = getProduct(productId); } catch { return { added: [] }; }
  if (!isGame(p)) return { added: [] };
  const have = (title: string) => Boolean(db.prepare(`SELECT id FROM items WHERE product = ? AND title = ? AND status != 'dropped'`).get(p.id, title));
  if (have(BIBLE_TITLE) || have(SLICE_TITLE) || hasBible(p.id)) return { added: [] };
  const rm = await import('./roadmap.ts');
  // First on the roadmap: before every item already there.
  const first = Number((db.prepare('SELECT MIN(ord) AS o FROM items WHERE product = ?').get(p.id) as any)?.o ?? 0);
  const bible = rm.addItem({ product: p.id, title: BIBLE_TITLE, goal: `The plan of ${p.name}'s whole world before more is built`, why: 'A game is a full, living world, not a demo: plan the world first (game quality rules).', criteria: BIBLE_CRITERIA, status: 'planned', priority: 'high', by, ord: first - 2 });
  const bt = rm.addTask({ item: bible.id, title: `${p.name}: world bible`, request: bibleRequest(p.name), criteria: BIBLE_CRITERIA, priority: 'high' });
  const slice = rm.addItem({ product: p.id, title: SLICE_TITLE, goal: `One area of ${p.name} finished to the full bar before the game widens`, why: 'Prove the world is alive in one place before building more (game quality rules).', criteria: SLICE_CRITERIA, status: 'planned', priority: 'high', by, ord: first - 1 });
  rm.addTask({ item: slice.id, title: `${p.name}: vertical slice`, request: sliceRequest(p.name), criteria: SLICE_CRITERIA, depends: [bt.id], priority: 'high' });
  return { added: [bible.id, slice.id] };
}
