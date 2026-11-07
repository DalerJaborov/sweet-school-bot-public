import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Offline preparation only: no database, network, credentials or apply mode. */
export async function prepareRecipeRepair({ planPath, snapshotPath, currentPath }) {
  const [planBytes, snapshotBytes, current] = await Promise.all([
    readFile(planPath), readFile(snapshotPath), readFile(currentPath),
  ]);
  const plan = JSON.parse(planBytes.toString('utf8'));
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
  if (plan.appliedToProduction !== false) throw new Error('Plan must explicitly be unapplied');
  if (!/^[a-f0-9-]+$/i.test(plan.lessonId)) throw new Error('Invalid lesson ID');
  if (sha256(current) !== plan.expectedSha256) throw new Error('Current image checksum does not match reviewed plan');
  const lessons = snapshot.courses.flatMap((course) => course.modules.flatMap((module) => module.lessons));
  const matches = lessons.filter((lesson) => lesson.id === plan.lessonId);
  if (matches.length !== 1) throw new Error('Expected exactly one matching lesson');
  const lesson = matches[0];
  const photos = JSON.parse(lesson.recipePhotos);
  if (!Array.isArray(photos) || photos.filter((path) => path === plan.expectedRecipePath).length !== 1) {
    throw new Error('Reviewed recipe path must occur exactly once');
  }
  if (!plan.expectedRecipePath.startsWith(`photos/${plan.lessonId}/`)) throw new Error('Recipe path belongs to another lesson');
  const replacement = await readFile(plan.replacementFile);
  const info = await sharp(replacement).metadata();
  if (!['png', 'jpeg'].includes(info.format) || !info.width || !info.height) throw new Error('Replacement is not a valid PNG/JPEG');
  const replacementSha256 = sha256(replacement);
  const newKey = `photos/${plan.lessonId}/recipe-${replacementSha256.slice(0, 16)}.${info.format === 'jpeg' ? 'jpg' : 'png'}`;
  return {
    dryRun: true, appliedToProduction: false,
    lessonId: lesson.id, titleFromSnapshot: lesson.title,
    snapshotSha256: sha256(snapshotBytes), capturedAt: snapshot.capturedAt ?? null,
    expected: { recipePhotos: lesson.recipePhotos, oldKey: plan.expectedRecipePath, oldSha256: plan.expectedSha256 },
    proposed: {
      recipePhotos: JSON.stringify(photos.map((path) => path === plan.expectedRecipePath ? newKey : path)),
      newKey, replacementFile: plan.replacementFile, replacementSha256,
      bytes: replacement.length, width: info.width, height: info.height,
    },
    applicationSteps: [
      'Review the replacement image and lesson identity before any production write.',
      'Upload replacement under newKey; verify stored object SHA256 equals replacementSha256.',
      'Update only this lesson with compare-and-swap WHERE id AND recipePhotos equal expected values; require exactly one row.',
      'If current values changed, stop and prepare a fresh plan. Do not overwrite another edit.',
      'Verify recipe rendering. Retain the original object and old recipePhotos for rollback.',
    ],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const allowed = ['--plan', '--snapshot', '--current-file', '--out'];
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || values[args[i]]) throw new Error('Usage: --plan FILE --snapshot FILE --current-file FILE --out NEW_FILE; apply is not supported');
    values[args[i]] = args[i + 1];
  }
  if (allowed.some((flag) => !values[flag])) throw new Error('All four input/output flags are required');
  const result = await prepareRecipeRepair({ planPath: values['--plan'], snapshotPath: values['--snapshot'], currentPath: values['--current-file'] });
  // Exclusive creation prevents accidental overwrites, including any input file.
  await writeFile(values['--out'], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log('Dry-run prepared. No database, server or source media changed.');
}
