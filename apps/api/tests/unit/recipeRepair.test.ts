import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { prepareRecipeRepair } from '../../scripts/prepare-recipe-repair.mjs';
let dir;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  dir = await mkdtemp(join(tmpdir(), 'school-recipe-test-'));
  const image = await sharp({ create: { width: 2, height: 3, channels: 3, background: 'white' } }).png().toBuffer();
  const replacementFile = join(dir, 'replacement.png');
  await writeFile(replacementFile, image);
  const plan = { lessonId: 'abc-123', expectedRecipePath: 'photos/abc-123/old.jpg', expectedSha256: createHash('sha256').update('original').digest('hex'), replacementFile, appliedToProduction: false };
  const snapshot = { courses: [{ modules: [{ lessons: [{ id: plan.lessonId, title: 'Banana', recipePhotos: JSON.stringify([plan.expectedRecipePath, 'keep.jpg']) }] }] }] };
  const paths = { planPath: join(dir, 'plan.json'), snapshotPath: join(dir, 'snapshot.json'), currentPath: join(dir, 'current.jpg') };
  await writeFile(paths.planPath, JSON.stringify(plan)); await writeFile(paths.snapshotPath, JSON.stringify(snapshot)); await writeFile(paths.currentPath, 'original');
  return { plan, snapshot, paths };
}
it('prepares a guarded replacement and preserves other recipe pictures', async () => {
  const { paths } = await fixture(); const result = await prepareRecipeRepair(paths);
  expect(result.appliedToProduction).toBe(false); expect(result.proposed.width).toBe(2);
  expect(JSON.parse(result.proposed.recipePhotos)[1]).toBe('keep.jpg');
  expect(result.expected.recipePhotos).toContain('old.jpg');
});
it('refuses a changed source image', async () => {
  const { paths } = await fixture(); await writeFile(paths.currentPath, 'changed');
  await expect(prepareRecipeRepair(paths)).rejects.toThrow('checksum');
});
it('refuses a missing reviewed recipe association', async () => {
  const { paths, snapshot } = await fixture(); snapshot.courses[0].modules[0].lessons[0].recipePhotos = '[]';
  await writeFile(paths.snapshotPath, JSON.stringify(snapshot));
  await expect(prepareRecipeRepair(paths)).rejects.toThrow('exactly once');
});
