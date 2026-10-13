#!/usr/bin/env node
/**
 * Validates this DSH bundle before it can be installed:
 * manifest shape, declared patch resolution, YAML legality (including the DSH
 * `!!js` tag, which plain js-yaml rejects), the preset's structural invariants,
 * and repo hygiene.
 *
 * Local run:
 *   npm install --no-save js-yaml@^4
 *   node scripts/validate.mjs            # validates the repo this file lives in
 *   node scripts/validate.mjs <dir>      # validates another checkout
 * CI run: see .github/workflows/validate.yml
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/**
 * DSH's loader registers `!!js` and evaluates those scalars when the owning
 * plugin activates. Reproduce the tag so this file validates; do NOT evaluate
 * anything here.
 */
const JsExpression = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string' && data.length > 0,
  construct: (data) => data,
});
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JsExpression]);

const passed = [];
const failed = [];
const check = (condition, message) => (condition ? passed : failed).push(message);

/** Registry-accepted package names, mirroring the shipped install-spec rules. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** Global, model-visible tool names this preset is allowed to name in a filter. */
const KNOWN_TOOLS = new Set([
  'pwsh', 'bash', 'read', 'write', 'edit', 'glob', 'grep',
  'web_search', 'web_fetch', 'todo_write', 'ask_user_question', 'present',
  'job_output', 'job_list', 'job_kill',
]);
const PERSONAL_PATH = /(?:[A-Za-z]:\\Users\\|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/)/;

// ------------------------------------------------------------------ manifest
console.log(`validating bundle at ${root}\n`);
const pkg = JSON.parse(read('package.json'));

check(PACKAGE_NAME.test(pkg.name), `package.json name is installable (${pkg.name})`);
check(/^\d+\.\d+\.\d+$/.test(pkg.version), `package.json version is semver (${pkg.version})`);
check(typeof pkg.description === 'string' && pkg.description.length > 0, 'package.json description is present');
check(pkg.type === 'module', 'package.json type is "module"');
check(typeof pkg.license === 'string' && pkg.license.length > 0, `package.json license is declared (${pkg.license})`);
// A bundle with no peerDependencies skips the runtime compatibility gate;
// declaring DSH peers without need only adds a way for installs to fail.
check(!Object.hasOwn(pkg, 'peerDependencies'), 'no peerDependencies declared (compat gate stays out of the way)');

const declared = pkg.dsh?.bundle?.patch;
check(declared !== undefined, 'dsh.bundle.patch is declared (required, else the installer reports not-a-bundle)');

const patchFiles = declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
check(
  patchFiles.length > 0 && patchFiles.every((f) => typeof f === 'string' && f.length > 0),
  'dsh.bundle.patch is a path or a list of paths',
);

// ----------------------------------------------------------- patch structure
const presetIds = new Set();
for (const rel of patchFiles) {
  const abs = path.join(root, rel);
  check(fs.existsSync(abs), `declared patch file exists: ${rel}`);
  if (!fs.existsSync(abs)) continue;

  const text = fs.readFileSync(abs, 'utf8');
  check(!PERSONAL_PATH.test(text), `${rel} carries no personal absolute paths`);

  let doc;
  try {
    doc = yaml.load(text, { schema: SCHEMA });
    check(true, `${rel} parses as YAML (including the !!js tag)`);
  } catch (error) {
    check(false, `${rel} parses as YAML (${error.message})`);
    continue;
  }

  check(Array.isArray(doc), `${rel} is a top-level YAML array`);
  if (!Array.isArray(doc)) continue;

  const presetRows = doc
    .filter((entry) => entry !== null && typeof entry === 'object' && Array.isArray(entry.insert))
    .flatMap((entry) => entry.insert)
    .filter((row) => row !== null && typeof row === 'object' && row.name === '@deepseek-ai/dsh-agent-preset');
  check(presetRows.length >= 1, `${rel} inserts at least one @deepseek-ai/dsh-agent-preset row`);

  for (const row of presetRows) {
    const config = row.config ?? {};
    const id = config.id;
    check(typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id), `${rel} preset config.id is a stable slug (${id})`);
    if (typeof id === 'string') {
      // The registry fails a duplicate preset id outright.
      check(!presetIds.has(id), `preset id ${id} is unique across this bundle`);
      presetIds.add(id);
    }
    check(Array.isArray(config.plugins) && config.plugins.length > 0, `preset ${id} declares a non-empty plugins list`);
    if (!Array.isArray(config.plugins)) continue;

    const rows = config.plugins.flatMap((p) => (p && p.group && Array.isArray(p.config) ? p.config : [p]));
    const subagents = rows.filter((r) => r && r.name === '@deepseek-ai/dsh-tool-subagent');
    check(subagents.length > 0, `preset ${id} mounts at least one tool-subagent instance`);

    const toolNames = subagents.map((s) => s.config?.toolName).filter(Boolean);
    check(new Set(toolNames).size === toolNames.length, `preset ${id} toolNames are unique (${toolNames.join(', ')})`);

    for (const sub of subagents) {
      const c = sub.config ?? {};
      const label = c.toolName ?? '(unnamed subagent)';
      const filter = c.toolFilter;

      check(!!filter && (Array.isArray(filter.allow) || Array.isArray(filter.deny)), `${label}: toolFilter names allow or deny`);
      for (const tool of (filter && filter.allow) || []) {
        check(KNOWN_TOOLS.has(tool), `${label}: allow-listed tool "${tool}" is a real global tool name`);
      }
      // maxDepth 0 forbids the very delegation it is meant to permit: the child
      // is at parent depth + 1, so every call fails with
      // "subagent depth 1 exceeds maxDepth 0".
      check(c.maxDepth !== 0, `${label}: maxDepth is not 0 (0 would forbid the delegation itself)`);
      if (c.persona !== undefined) {
        check(typeof c.persona === 'string' && c.persona.trim().length > 100, `${label}: persona is a non-trivial string`);
      }
      if (c.backgroundMode === 'continuable') {
        check(c.enableRunInBackground !== false, `${label}: continuable mode must not disable background runs`);
      }
    }
  }
}

// ----------------------------------------------------------------- repo files
for (const rel of ['README.md', 'LICENSE', 'lib/index.js']) {
  check(fs.existsSync(path.join(root, rel)), `${rel} is present`);
}

// --------------------------------------------------------------------- report
for (const line of passed) console.log(`PASS  ${line}`);
for (const line of failed) console.log(`FAIL  ${line}`);
console.log(`\n${passed.length} passed, ${failed.length} failed`);
process.exit(failed.length === 0 ? 0 : 1);
