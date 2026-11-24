/**
 * Read SWE-bench Lite out of the HuggingFace dataset viewer.
 *
 * The framework is shell because the host is only promised curl, tar and docker
 * (`scripts/install.sh#require_host`). Parsing the dataset is the one place that is
 * not honest to do in shell: a `problem_statement` contains newlines, quotes and
 * code fences, so a sed/awk reader would be a bug generator. Node is already a hard
 * requirement of this bench — `build` downloads a pinned runtime — so the reader
 * uses that runtime rather than adding one.
 *
 * Two verbs, both writing to stdout:
 *
 *   rows   <json-file>                one JSON object per line, the fields we keep
 *   select <json-file> <n> <mode>     a stratified sample, as ids
 *
 * The dataset viewer pages at 100 rows, so `rows` is fed a file the shell assembled
 * from those pages — see instances.sh.
 */
import fs from 'node:fs';

const [verb, file, ...rest] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!verb || !file) fail('usage: dataset.mjs <rows|select> <json-file> [args]');
if (!fs.existsSync(file)) fail(`no such file: ${file}`);

/** The dataset viewer's payload, or a single row, whichever we were handed. */
function loadRows(path) {
  const parsed = JSON.parse(fs.readFileSync(path, 'utf-8'));
  // A paged fetch writes one JSON document per page, concatenated by the shell as a
  // JSON array of pages; a single page is also accepted so the reader can be probed
  // on one.
  const documents = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  for (const document of documents) {
    if (document && Array.isArray(document.rows)) {
      for (const entry of document.rows) {
        // The viewer wraps each record as { row: {...} }; a raw dump does not.
        rows.push(entry && entry.row ? entry.row : entry);
      }
    } else if (document && document.instance_id) {
      rows.push(document);
    }
  }
  return rows;
}

/**
 * The fields a rollout needs, and nothing else. `problem_statement` is the prompt;
 * the two test lists are what grading checks, and carrying them means a run does not
 * have to re-fetch the dataset to know what it is aiming at.
 */
function project(row) {
  const asList = (value) => {
    if (Array.isArray(value)) return value.map((entry) => String(entry));
    // Some dumps serialise these as a JSON string inside a string.
    if (typeof value === 'string' && value.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  return {
    instance_id: String(row.instance_id ?? ''),
    repo: String(row.repo ?? ''),
    base_commit: String(row.base_commit ?? ''),
    environment_setup_commit: String(row.environment_setup_commit ?? ''),
    version: String(row.version ?? ''),
    image: String(row.image ?? ''),
    problem_statement: String(row.problem_statement ?? ''),
    difficulty: String(row.difficulty ?? ''),
    FAIL_TO_PASS: asList(row.FAIL_TO_PASS),
    PASS_TO_PASS: asList(row.PASS_TO_PASS),
  };
}

function dieOnBadRows(rows) {
  if (rows.length === 0) fail('the dataset payload held no rows (did the download succeed?)');
  const missing = rows.filter((row) => !row.instance_id || !row.problem_statement);
  if (missing.length > 0) {
    fail(`${missing.length} row(s) are missing instance_id or problem_statement`);
  }
}

const rows = loadRows(file).map(project);

if (verb === 'rows') {
  dieOnBadRows(rows);
  for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
  process.exit(0);
}

if (verb === 'select') {
  const wanted = Number.parseInt(rest[0] ?? '0', 10);
  const mode = rest[1] ?? 'repo';
  if (!Number.isInteger(wanted) || wanted <= 0) fail('select needs a positive count');
  dieOnBadRows(rows);

  // Deterministic: a selection that changes between runs is not a pre-registration.
  // Sorting by id first makes the choice independent of the order the API returned,
  // so re-running `select` on the same dataset reproduces the same sample.
  const sorted = [...rows].sort((a, b) => a.instance_id.localeCompare(b.instance_id));

  if (mode === 'first') {
    for (const row of sorted.slice(0, wanted)) process.stdout.write(`${row.instance_id}\n`);
    process.exit(0);
  }

  if (mode !== 'repo') fail(`unknown stratify mode: ${mode} (use "repo" or "first")`);

  // Stratified by repository, so no single project dominates a sample. One row per
  // repository on the first pass, then round-robin over the leftovers: that keeps the
  // repositories balanced even when `wanted` is smaller than the number of repos.
  const byRepo = new Map();
  for (const row of sorted) {
    if (!byRepo.has(row.repo)) byRepo.set(row.repo, []);
    byRepo.get(row.repo).push(row);
  }
  const repos = [...byRepo.keys()].sort();
  const picked = [];
  let round = 0;
  while (picked.length < wanted) {
    let addedThisRound = 0;
    for (const repo of repos) {
      if (picked.length >= wanted) break;
      const bucket = byRepo.get(repo);
      if (round < bucket.length) {
        picked.push(bucket[round]);
        addedThisRound += 1;
      }
    }
    if (addedThisRound === 0) break; // the dataset is exhausted
    round += 1;
  }
  for (const row of picked) process.stdout.write(`${row.instance_id}\n`);
  process.exit(0);
}

fail(`unknown verb: ${verb} (use "rows" or "select")`);
