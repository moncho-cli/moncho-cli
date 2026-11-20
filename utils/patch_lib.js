import fs from 'fs';
import {
  parsePatch as parseUnifiedDiff,
  applyPatch as applyUnifiedDiff,
  reversePatch,
} from 'diff';
import { resolveProjectPath, PathSafetyError } from './path-safety.js';

/**
 * Max context mismatches tolerated by the underlying applier. 1 is enough to
 * absorb the common "source has no trailing newline" mismatch, while jsdiff
 * still requires deletions and insertion-adjacent context to match exactly.
 */
export const PATCH_FUZZ_FACTOR = 1;

/** How far from the declared line we search when reporting hunk drift. */
export const FUZZ_WINDOW = 10;

/** Canonical example embedded in error guidance. */
export const PATCH_EXAMPLE = [
  '--- a/path/to/file.js',
  '+++ b/path/to/file.js',
  '@@ -1,3 +1,4 @@',
  ' const x = 1;',
  '+const y = 2;',
  ' ',
  ' const z = 3;'
].join('\n');

export class PatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { code: this.code, message: this.message, ...this.details };
  }
}

function stripDiffPrefix(fileName) {
  if (!fileName) return null;
  const value = String(fileName).trim();
  if (value === '' || value === '/dev/null') return null;
  return value.replace(/^a\//, '').replace(/^b\//, '');
}

function isNewFilePatch(parsed) {
  return parsed.oldFileName === '/dev/null' || parsed.isCreate === true;
}

function classifyParseError(error) {
  const message = (error && error.message) || 'Invalid patch.';
  if (/did not match|more lines than expected/i.test(message)) return 'HUNK_COUNT_MISMATCH';
  if (/contained invalid line/i.test(message)) return 'INVALID_PATCH_LINE';
  return 'INVALID_PATCH';
}

function parseSingleFile(patchString) {
  if (typeof patchString !== 'string' || patchString.trim() === '') {
    throw new PatchError('INVALID_PATCH', 'The patch string is empty or missing.');
  }
  let parsedList;
  try {
    parsedList = parseUnifiedDiff(patchString);
  } catch (error) {
    throw new PatchError(classifyParseError(error), error.message, { example: PATCH_EXAMPLE });
  }
  if (parsedList.length > 1) {
    throw new PatchError(
      'MULTIPLE_FILES',
      'The patch contains more than one file section. Send one edit_file call per file; the engine applies one file at a time.',
    );
  }
  const parsed = parsedList[0];
  if (!parsed || !parsed.hunks || parsed.hunks.length === 0) {
    throw new PatchError('NO_HUNKS', 'No unified diff hunks (@@ ...) were found in the patch.', {
      example: PATCH_EXAMPLE
    });
  }
  return parsed;
}

function oldSideLines(hunk) {
  return hunk.lines.filter((line) => line[0] !== '+').map((line) => line.slice(1));
}

function locateHunk(sourceLines, hunk) {
  const pattern = oldSideLines(hunk);
  const expectedIndex = hunk.oldStart - 1;
  if (pattern.length === 0) {
    return { matchedLine: expectedIndex + 1, lineDrift: 0, ambiguousMatches: 1 };
  }
  const min = Math.max(0, expectedIndex - FUZZ_WINDOW);
  const max = Math.min(sourceLines.length - pattern.length, expectedIndex + FUZZ_WINDOW);
  const exact = [];
  for (let i = min; i <= max; i++) {
    let ok = true;
    for (let k = 0; k < pattern.length; k++) {
      if (sourceLines[i + k] !== pattern[k]) { ok = false; break; }
    }
    if (ok) exact.push(i);
  }
  if (exact.length === 0) return { matchedLine: null, lineDrift: null, ambiguousMatches: 0 };
  exact.sort((a, b) => Math.abs(a - expectedIndex) - Math.abs(b - expectedIndex) || a - b);
  return { matchedLine: exact[0] + 1, lineDrift: exact[0] - expectedIndex, ambiguousMatches: exact.length };
}

function firstMismatch(sourceLines, hunk) {
  const pattern = oldSideLines(hunk);
  const start = hunk.oldStart - 1;
  for (let k = 0; k < pattern.length; k++) {
    if (sourceLines[start + k] !== pattern[k]) {
      return { line: start + k + 1, expected: pattern[k], actual: sourceLines[start + k] };
    }
  }
  return null;
}

function applyWithVerification(source, parsed) {
  const expected = applyUnifiedDiff(source, parsed, { fuzzFactor: PATCH_FUZZ_FACTOR });
  if (expected === false) {
    throw new PatchError(
      'HUNK_MISMATCH',
      'The patch context does not match the file; no hunks could be applied.',
      {
        firstMismatch: firstMismatch(source.split('\n'), parsed.hunks[0]),
        hint: 'Re-read the file with read_file (lineNumbers:false) and regenerate the patch with exact context.'
      }
    );
  }

  // Independent verification: reverse-apply the result and require a round-trip.
  // Patches carrying a "\ No newline at end of file" marker cannot round-trip
  // exactly (the marker is only emitted for one side), so a string result is
  // accepted for those.
  const hasNoNewlineMarker = parsed.hunks.some((h) => h.lines.some((l) => l.startsWith('\\')));
  let independent = false;
  try {
    independent = applyUnifiedDiff(expected, reversePatch(parsed), { fuzzFactor: PATCH_FUZZ_FACTOR });
  } catch {
    independent = false;
  }
  const independentApplyMatches =
    independent === source || (hasNoNewlineMarker && typeof independent === 'string');

  return { expected, independentApplyMatches };
}

/**
 * Apply a unified diff to a file on disk. The file is only reported as
 * successfully patched when its final bytes match the patch-derived result.
 */
export function applyPatch(patchString, filePath) {
  const parsed = parseSingleFile(patchString);

  let absPath;
  try {
    absPath = resolveProjectPath(filePath);
  } catch (error) {
    if (error instanceof PathSafetyError) throw new PatchError(error.code, error.message);
    throw error;
  }

  const headerPath = stripDiffPrefix(parsed.newFileName);
  if (headerPath) {
    let headerAbs;
    try {
      headerAbs = resolveProjectPath(headerPath);
    } catch (error) {
      throw new PatchError(
        'PATH_MISMATCH',
        `The +++ header path ${JSON.stringify(headerPath)} is not a safe relative path.`,
        { path: filePath, headerPath }
      );
    }
    if (headerAbs !== absPath) {
      throw new PatchError(
        'PATH_MISMATCH',
        `The +++ header path (${headerPath}) does not match the path argument (${filePath}). Nothing was changed.`,
        { path: filePath, headerPath, hint: 'Use the same relative path in the patch header and the path argument.' }
      );
    }
  }

  const isNew = isNewFilePatch(parsed);
  const exists = fs.existsSync(absPath);
  if (isNew && exists) {
    throw new PatchError('FILE_ALREADY_EXISTS', `Refusing to create ${filePath}: the file already exists.`, { path: filePath });
  }
  if (!isNew && !exists) {
    throw new PatchError('FILE_NOT_FOUND', `Target file not found: ${filePath}`, { path: filePath });
  }

  const original = exists ? fs.readFileSync(absPath, 'utf-8') : '';
  const { expected, independentApplyMatches } = applyWithVerification(original, parsed);

  const sourceLines = original.split('\n');
  const hunkReports = parsed.hunks.map((hunk, i) => {
    const loc = locateHunk(sourceLines, hunk);
    return {
      hunk: i + 1,
      expectedLine: hunk.oldStart,
      matchedLine: loc.matchedLine,
      lineDrift: loc.lineDrift,
      ambiguousMatches: loc.ambiguousMatches,
      oldLines: hunk.oldLines,
      newLines: hunk.newLines
    };
  });

  const targetPath = exists ? fs.realpathSync(absPath) : absPath;
  const tempPath = `${targetPath}.moncho-patch-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, expected, 'utf-8');
    if (exists) fs.chmodSync(tempPath, fs.statSync(targetPath).mode);

    const staged = fs.readFileSync(tempPath, 'utf-8');
    if (staged !== expected) {
      throw new PatchError('VERIFICATION_FAILED', 'Staged file differs from the expected patched content. Nothing was changed.', {
        expectedBytes: expected.length,
        actualBytes: staged.length
      });
    }

    fs.renameSync(tempPath, targetPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }

  const readback = fs.readFileSync(targetPath, 'utf-8');
  if (readback !== expected) {
    fs.writeFileSync(targetPath, original, 'utf-8');
    throw new PatchError(
      'POST_WRITE_VERIFICATION_FAILED',
      'Verification failed after writing: the file on disk does not match the patch result. The original file was restored.',
      { expectedBytes: expected.length, actualBytes: readback.length }
    );
  }

  const linesAdded = parsed.hunks.reduce((sum, h) => sum + h.newLines, 0);
  const linesRemoved = parsed.hunks.reduce((sum, h) => sum + h.oldLines, 0);

  return {
    status: 'success',
    path: filePath,
    hunksApplied: parsed.hunks.length,
    linesAdded,
    linesRemoved,
    verification: {
      oldSideMatched: true,
      independentApplyMatches,
      readbackMatches: true,
      expectedBytes: expected.length,
      actualBytes: readback.length,
      hunks: hunkReports
    },
    message: `Successfully applied and verified ${parsed.hunks.length} hunk(s) to ${filePath}.`
  };
}

/** Pure in-memory helper used by tests and callers that do not want file I/O. */
export function applyPatchToString(content, patchString) {
  const parsed = parseSingleFile(patchString);
  return applyWithVerification(content, parsed).expected;
}

// Backwards-compatible export name; now backed by the `diff` library.
export { parseUnifiedDiff as parsePatch };
