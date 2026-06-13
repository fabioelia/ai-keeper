'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_SETTINGS } = require('./constants');

// Tiny JSON-file settings store kept under Electron's userData dir.
class Store {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULT_SETTINGS, ...this.read() };
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  get() {
    return { ...this.data };
  }

  set(patch) {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (patch[key] !== undefined) this.data[key] = patch[key];
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
    return this.get();
  }
}

module.exports = { Store };
