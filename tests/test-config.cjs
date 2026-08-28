const path = require('path');

const projectDir = path.resolve(__dirname, '..');

module.exports = Object.freeze({
  projectDir,
  htmlPath: path.join(projectDir, 'index.html'),
  tempDir: path.join(projectDir, 'qa', 'results', 'tmp'),
  resultsDir: path.join(projectDir, 'qa', 'results'),
  fixturesDir: path.join(projectDir, 'qa', 'results', 'fixtures'),
  launchOptions: Object.freeze({ headless: true }),
  contextOptions: Object.freeze({
    viewport: Object.freeze({ width: 1280, height: 900 }),
    acceptDownloads: true
  }),
  timeouts: Object.freeze({
    navigation: 10000,
    scan: 10000,
    clean: 15000
  })
});
