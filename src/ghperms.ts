// GitHub App permissions, in one place (J, 2026-11-08: Hawkes Games' builds waited three hours on "Actions: write", and
// the fix took two steps on GitHub that nobody would guess: add it under the app's Permissions, then accept it on the
// installation's page. "I don't want studio customers to have to do that step if at all possible but if it's needed
// they should at least be walked through it").
//
//   - APP_PERMISSIONS is everything Studio asks for when its app is made (github-app.ts manifest) and checks on an app a
//     customer brings (useExistingApp). Each has its reason (WHY) so the setup screens and docs say what it's for.
//   - Actions: write is NOT asked for. Studio's builds run in its own cloud (Hawkes Gen, Cloud Build), so a customer's
//     Actions minutes and that permission are never needed. It is only for a project that chose to build in its own
//     GitHub Actions and wants Studio's Build button to start that workflow (OPTIONAL); without it, that workflow still
//     runs on its own triggers.
//   - An installation made before the app asked for something has it pending: GitHub doesn't grant it until the account
//     owner accepts it on the installation's page. pending() and missingRequired() say which, acceptSteps() walks them
//     through it, and Studio looks again by itself when they come back (the app's installation webhook, the setup URL
//     GitHub returns to, and the dashboard being shown again: never a timer). docs/github-permissions.md.

export type Level = 'read' | 'write' | 'admin';
export type Perms = Record<string, string>;

/** What Studio's app asks for at install time: everything it uses, nothing more. */
export const APP_PERMISSIONS: Record<string, Level> = {
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  workflows: 'write',
  pages: 'write',
  administration: 'write',
  actions: 'read',
  checks: 'read',
};

/** Why Studio needs each, in a customer's words (setup screens, the chooser page, docs). */
export const WHY: Record<string, string> = {
  metadata: 'see the repositories you chose (GitHub requires it for every app)',
  contents: "read your code and push its agents' branches, beta and the builds it makes",
  pull_requests: 'open pull requests for its changes and merge them into beta (and main when you go live)',
  workflows: "add its push hook (.github/workflows/hawkes-studio.yml) and commit changes that touch your workflows",
  pages: 'publish a site with GitHub Pages when you choose that for going live',
  administration: "adjust main's rules once (the setup card's rules step), so going live needs no extra step",
  actions: "read your own GitHub Actions builds' results, if a project builds there",
  checks: 'see whether your checks passed before merging',
};

/** Never asked for at install; only for the feature named. Studio works without them. */
export const OPTIONAL: Record<string, { level: Level; why: string }> = {
  actions: { level: 'write', why: "let Studio's Build button start a project's own GitHub Actions build (Studio's own builds run in its cloud and don't need it)" },
};

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };
const WORD: Record<string, string> = {
  metadata: 'Metadata', contents: 'Contents', pull_requests: 'Pull requests', workflows: 'Workflows', pages: 'Pages',
  administration: 'Administration', actions: 'Actions', checks: 'Checks',
};
/** "Pull requests: write", as GitHub's own pages name it (Read and write is "write"). */
export const label = (key: string, level: string) => `${WORD[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())}: ${level}`;

/** Whether `have` gives at least `level` of `key`. */
export const grants = (have: Perms | null | undefined, key: string, level: string) => (RANK[have?.[key] ?? ''] ?? 0) >= (RANK[level] ?? 9);

/** The keys of `want` that `have` falls short of (all of them when `have` is unknown is the caller's call: pass {}). */
export function shortOf(have: Perms | null | undefined, want: Perms = APP_PERMISSIONS): string[] {
  return Object.entries(want).filter(([k, v]) => !grants(have, k, v)).map(([k]) => k);
}

/** Required permissions an installation lacks: Studio can't do its work there until they are accepted. */
export const missingRequired = (installation: Perms | null | undefined) => shortOf(installation, APP_PERMISSIONS);

/**
 * Permissions the app asks for that this installation hasn't accepted yet (GitHub's "review request" on the installation
 * page). The app's own list (GET /app) may hold more than APP_PERMISSIONS when its owner added one on GitHub.
 */
export function pending(app: Perms | null | undefined, installation: Perms | null | undefined): string[] {
  if (!app) return [];
  return Object.entries(app).filter(([k, v]) => !grants(installation, k, v)).map(([k]) => k);
}

/** "Contents: write, Pull requests: write" for keys, at the level asked (the app's own level when given). */
export function labels(keys: string[], levels: Perms = APP_PERMISSIONS as Perms) {
  return keys.map((k) => label(k, levels[k] ?? OPTIONAL[k]?.level ?? 'write')).join(', ');
}

/**
 * The walk-through, step by step (the two steps J found on 2026-11-08, in the order GitHub needs them). `appHas`: the app
 * already asks for it, so accepting is the only step; otherwise its owner adds it to the app first.
 */
export function acceptSteps(o: { what: string; account?: string | null; appHas: boolean; ownsApp?: boolean }): string[] {
  const who = o.account ? `the ${o.account} account` : 'the account the app is installed on';
  const steps: string[] = [];
  if (!o.appHas) {
    steps.push(o.ownsApp === false
      ? `Hawkes Studio's app doesn't ask for ${o.what} yet; Studio's team adds it (nothing for you to do until then).`
      : `Open "The app's Permissions on GitHub", set ${o.what.replace(/: write/g, ' to "Read and write"').replace(/: read/g, ' to "Read-only"')}, and press Save changes at the bottom. GitHub then asks every installation to accept it.`);
  }
  steps.push(`Open "Installation page on GitHub" as an owner of ${who}. Near the top, GitHub says the app is asking for updated permissions: press Review request.`);
  steps.push('Press Accept new permissions. Nothing else on that page needs changing.');
  steps.push("Come back to Studio: it notices by itself, checks again and carries on (builds that were waiting start again). There's nothing to press.");
  return steps;
}

/** The steps as numbered lines, for a card or a checklist item. */
export const stepsText = (steps: string[]) => steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
