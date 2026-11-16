#!/usr/bin/env node
// Entry point of the published package: checks the runtime, then loads the bundled server.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node.js 22.13 or newer is required (this is ${process.versions.node}).`);
  process.exit(1);
}

// The built-in SQLite driver prints an "experimental" notice on first use; it is not useful to operators.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : (warning?.message ?? '');
  if (text.includes('SQLite is an experimental feature')) return;
  return emitWarning.call(process, warning, ...rest);
};

await import('../dist/server.mjs');
