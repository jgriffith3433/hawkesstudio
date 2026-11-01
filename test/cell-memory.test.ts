import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.STUDIO_CELLS_MASTER ??= 'test-master-key-that-is-long-enough-0123456789';
const { CELL_LIMITS, withCellMemory, cellService } = await import('../src/cellrun.ts');

test('a new cell gets 4 GiB on one vCPU', () => {
  const s = cellService('acme', { sub: 's', email: 'a@b.c' }, 'r/i:1', { project: 'p', projectNumber: '1', region: 'us-east4', serviceAccount: 'sa@x', bucket: 'b', agentJob: 'j', lane: 'live', publicUrl: 'https://x', controlUrl: 'https://x' } as any);
  assert.deepEqual(s.template.containers[0].resources.limits, { cpu: '1', memory: '4Gi' });
  assert.equal(CELL_LIMITS.memory, '4Gi');
});

test('an older, smaller cell is raised; a bigger one and its CPU are kept', () => {
  assert.deepEqual(withCellMemory({ cpu: '1', memory: '2Gi' }), { cpu: '1', memory: '4Gi' });
  assert.deepEqual(withCellMemory({ cpu: '1', memory: '512Mi' }), { cpu: '1', memory: '4Gi' });
  assert.deepEqual(withCellMemory({ cpu: '2', memory: '8Gi' }), { cpu: '2', memory: '8Gi' });
  assert.deepEqual(withCellMemory({ cpu: '1', memory: '4096Mi' }), { cpu: '1', memory: '4096Mi' });
  assert.deepEqual(withCellMemory(undefined), { cpu: '1', memory: '4Gi' });
});
