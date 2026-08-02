#!/usr/bin/env node
/**
 * Portable test runner.
 *
 * `node --test` takes a directory on Node 20 but a glob on Node 22, and
 * neither form works on both. Resolving the file list here and passing
 * explicit paths works identically on every supported version and on both
 * Windows and Linux.
 *
 * Usage: node tests/run.js unit integration
 *        node tests/run.js            (all suites)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TESTS_DIR = __dirname;
const suites = process.argv.slice(2);
const dirs = suites.length ? suites : ['unit', 'integration'];

const files = [];
for (const suite of dirs) {
  const dir = path.join(TESTS_DIR, suite);
  if (!fs.existsSync(dir)) {
    console.error(`No such test suite: ${suite}`);
    process.exit(1);
  }
  fs.readdirSync(dir)
    .filter(f => f.endsWith('.test.js'))
    .sort()
    .forEach(f => files.push(path.join(dir, f)));
}

if (!files.length) {
  console.error(`No test files found in: ${dirs.join(', ')}`);
  process.exit(1);
}

console.log(`Running ${files.length} test file(s) from ${dirs.join(', ')}`);

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: path.resolve(TESTS_DIR, '..')
});

process.exit(result.status === null ? 1 : result.status);
