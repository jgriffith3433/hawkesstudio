// On Cloud Run every agent's and Talk's run is a job on its own machine (roles.ts): the agent roles get their sandbox
// tool lists there and Talk its cloud ones (a shell, the editor, the web) with its <!-- cloud --> instructions only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.K_SERVICE = 'hawkes-studio-test';
process.env.STUDIO_DETACH = 'cloudrun';
delete process.env.HAWKES_AGENT_USER;
const roles = await import('../src/roles.ts');

test('Cloud Run jobs: Talk and the agents get the shell and the web', () => {
  const talk = roles.loadRole('talk');
  for (const t of ['Bash', 'Edit', 'Write', 'WebFetch', 'mcp__hawkesstudio']) assert.ok(talk.allowed.includes(t), `talk: ${t}`);
  assert.ok(!talk.disallowed.includes('Bash'));
  assert.match(talk.body, /machine of your own/);
  assert.match(talk.body, /studio_github_api/);
  assert.doesNotMatch(talk.body, /\.talk\/|studio_fastlane \{/, "not the server's worktree instructions");
  for (const r of ['fixer', 'builder', 'content'] as const) {
    const role = roles.loadRole(r);
    for (const t of ['Bash', 'WebFetch', 'WebSearch']) assert.ok(role.allowed.includes(t), `${r}: ${t}`);
  }
  // The read-only roles stay as they are.
  assert.ok(!roles.loadRole('scout').allowed.some((t) => /^(Edit|Write)$/.test(t)));
  assert.ok(!roles.loadRole('reviewer').allowed.some((t) => /^(Edit|Write)$/.test(t)));
});

test('sections: a cloud part replaces the server parts only in a job', () => {
  const b = 'a\n<!-- sandbox -->\nS\n<!-- /sandbox -->\n<!-- cloud -->\nC\n<!-- /cloud -->\n<!-- no-sandbox -->\nN\n<!-- /no-sandbox -->\nz';
  assert.equal(roles.sections(b, true, true).replace(/\s+/g, ' '), 'a C z');
  assert.equal(roles.sections(b, true).replace(/\s+/g, ' '), 'a S z');
  assert.equal(roles.sections(b, false).replace(/\s+/g, ' '), 'a N z');
  assert.equal(roles.sections('a\n<!-- sandbox -->\nS\n<!-- /sandbox -->\nz', true, true).replace(/\s+/g, ' '), 'a S z', 'no cloud part: the sandbox one');
});
