'use strict';

const { readdirSync, statSync } = require('node:fs');
const { join, extname } = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.cwd();
const ENTRY_FILES = ['server.js', 'homekit.js', 'twilio-api.js'].map((file) => join(ROOT, file));

function collectJsFiles(dirPath) {
  const files = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && extname(entry.name) === '.js') {
      files.push(fullPath);
    }
  }
  return files;
}

const srcFiles = [];
const srcRoot = join(ROOT, 'src');
try {
  if (statSync(srcRoot).isDirectory()) {
    srcFiles.push(...collectJsFiles(srcRoot).sort());
  }
} catch {
  // src directory is optional for this command.
}

const filesToCheck = [...ENTRY_FILES, ...srcFiles];
const result = spawnSync(process.execPath, ['--check', ...filesToCheck], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
