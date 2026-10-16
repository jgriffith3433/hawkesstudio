// Roles and skills in git: every role file parses, has a model and instructions, and its Claude Code flags carry them;
// the read-only roles can't edit; every skill has a name and a description; the sandbox keeps secrets out.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const roles = await import('../src/roles.ts');
const { sandboxEnv } = await import('../src/sandbox.ts');
const { roleOf } = await import('../src/agents.ts');

test('every role loads with a model, tools and instructions', () => {
  for (const r of roles.listRoles()) {
    assert.ok(!('error' in r), `${r.name}: ${(r as any).error}`);
    assert.match((r as any).model, /^claude-(opus|sonnet|haiku)-/, r.name);
    assert.ok((r as any).chars > 200, `${r.name} has instructions`);
  }
  assert.equal(roles.loadRole('fixer').model, roles.MODEL_IDS.sonnet, 'routine fixes on Sonnet');
  assert.equal(roles.loadRole('builder').model, roles.MODEL_IDS.opus, 'hard work on Opus');
  for (const ro of ['scout', 'reviewer', 'pm', 'talk'] as const) {
    const r = roles.loadRole(ro);
    assert.ok(!r.allowed.some((t) => /^(Edit|Write)$/.test(t)), `${ro} can't edit`);
  }
  assert.ok(roles.loadRole('scout').disallowed.includes('Edit'));
  assert.equal(roles.jobModel('dedupe'), roles.MODEL_IDS.haiku);
  assert.throws(() => roles.loadRole('nope'), /No role/);
});

test('role flags: model, the stable instructions, the plugin with the skills', () => {
  const { args, role } = roles.roleArgs('fixer', { extraAllowed: ['mcp__hawkesstudio__memory_search'], extraPrompt: 'EXTRA' });
  const at = (f: string) => args[args.indexOf(f) + 1];
  assert.equal(at('--model'), role.model);
  assert.ok(at('--append-system-prompt').startsWith(role.body), 'the role first (it caches), then the extra');
  assert.ok(at('--append-system-prompt').endsWith('EXTRA'));
  assert.match(at('--allowedTools'), /mcp__hawkesstudio__memory_search/);
  assert.equal(at('--max-turns'), '80');
  assert.match(at('--plugin-dir'), /\.claude$/);
  assert.equal(roles.roleArgs('fixer').args.join('\u0000'), roles.roleArgs('fixer').args.join('\u0000'), 'stable between runs');
});

test('skills have names and descriptions', () => {
  const skills = roles.listSkills();
  assert.ok(skills.length >= 10);
  for (const s of skills) assert.ok(s.name && s.description.length > 40, s.name);
  for (const want of ['unity-build-debugging', 'playtest-scenario', 'go-live-checklist', 'gen-assets', 'shared-memory', 'windows-shell-quirks']) assert.ok(skills.some((s) => s.name === want), want);
});

test('which role a change runs as', () => {
  assert.equal(roleOf({ infra: true, request: 'fix the login' }), 'infra');
  assert.equal(roleOf({ request: 'Write new dialogue for Gloob on floor 950' }), 'content');
  assert.equal(roleOf({ request: 'Add a pause button' }), 'builder');
  assert.equal(roleOf({ findings: ['f_1'], title: 'Fix: black screen after loading' }), 'fixer');
});

test('the sandbox environment has no secrets but the Claude login', () => {
  const env = sandboxEnv({ PATH: '/usr/bin', GITHUB_TOKEN: 'x', AWS_ACCESS_KEY_ID: 'x', HAWKES_AWS_ROLE: '1', ELEVENLABS_API_KEY: 'x', HAWKESGEN_KEY: 'x', STUDIO_MCP_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'k', TALK_CONVERSATION: 't_1' });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH', 'TALK_CONVERSATION']);
});
