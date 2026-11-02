// Loads every file in src/ into one shared global scope, the way Apps Script
// does, so tests can call EmailParser, SyncPlanner, etc. directly.
// Node's test runner runs each test file in its own process, so globals
// don't leak between test files.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src');

function loadApp() {
  if (global.__appLoaded) return global;
  fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort().forEach((file) => {
    vm.runInThisContext(fs.readFileSync(path.join(SRC, file), 'utf8'), { filename: file });
  });
  global.__appLoaded = true;
  return global;
}

module.exports = { loadApp };
