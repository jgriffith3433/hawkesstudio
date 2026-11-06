import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.STUDIO_CELLS_MASTER ??= 'test-master-key-that-is-long-enough-0123456789';
const { CELL_LIMITS, withCellLimits, cellService } = await import('../src/cellrun.ts');

test('a new cell gets 4 GiB on two vCPUs', () => {
  const s = cellService('acme', { sub: 's', email: 'a@b.c' }, 'r/i:1', { project: 'p', projectNumber: '1', region: 'us-east4', serviceAccount: 'sa@x', bucket: 'b', agentJob: 'j', lane: 'live', publicUrl: 'https://x', controlUrl: 'https://x' } as any);
  assert.deepEqual(s.template.containers[0].resources.limits, { cpu: '2', memory: '4Gi' });
  assert.equal(CELL_LIMITS.memory, '4Gi');
});

test('an older, smaller cell is raised; a bigger one is kept', () => {
  assert.deepEqual(withCellLimits({ cpu: '1', memory: '2Gi' }), { cpu: '2', memory: '4Gi' });
  assert.deepEqual(withCellLimits({ cpu: '1', memory: '512Mi' }), { cpu: '2', memory: '4Gi' });
  assert.deepEqual(withCellLimits({ cpu: '1000m', memory: '4Gi' }), { cpu: '2', memory: '4Gi' });
  assert.deepEqual(withCellLimits({ cpu: '4', memory: '8Gi' }), { cpu: '4', memory: '8Gi' });
  assert.deepEqual(withCellLimits({ cpu: '2000m', memory: '4096Mi' }), { cpu: '2000m', memory: '4096Mi' });
  assert.deepEqual(withCellLimits({ memory: '4Gi' }), { cpu: '2', memory: '4Gi' });
  assert.deepEqual(withCellLimits(undefined), { cpu: '2', memory: '4Gi' });
});
