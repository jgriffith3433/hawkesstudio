// Gen keys the server keeps in /etc/hawkes/keys.env, as shell scripts deploy.mjs runs there (no side effects on import).

import fs from 'node:fs';

/** A shell script that adds DEV_GEN_KEY_<ID> to /etc/hawkes/keys.env for each product that has none (idempotent). */
export function perProductKeys(products = JSON.parse(fs.readFileSync(new URL('../products.json', import.meta.url), 'utf8')).products) {
  return products
    .map((p) => {
      const v = `DEV_GEN_KEY_${p.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
      const make = `import('./src/auth.ts').then(({createClient})=>{process.stdout.write('${v}='+createClient('beta-${p.id}','user',['${p.id}']).key+'\\n')})`;
      return `sudo grep -q '^${v}=' /etc/hawkes/keys.env || ( cd /srv/hawkes/hawkesgen && sudo -u hawkes node --disable-warning=ExperimentalWarning -e "${make}" | sudo tee -a /etc/hawkes/keys.env > /dev/null && echo '${v} created' )`;
    })
    .join('\n');
}
