const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const playwrightPackage = require('playwright/package.json');
const config = require('./test-config.cjs');
const { generateFixtures } = require('./fixtures/generate-fixtures.cjs');

const RUN_COUNT = 5;
const MB = 1024 * 1024;
const BUDGETS = Object.freeze({
  typical: Object.freeze({ scanMs: 5000, cleanMs: 10000 }),
  boundary: Object.freeze({ scanMs: 60000, cleanMs: 60000 }),
  maxLongTaskMs: 2000,
  maxHeapMb: 512
});

function fixturePath(fixture) {
  return path.join(config.fixturesDir, fixture.fileName);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

async function heapUsed(cdp) {
  const usage = await cdp.send('Runtime.getHeapUsage');
  return usage.usedSize;
}

async function measurePhase(page, cdp, action, waitForCompletion) {
  const startLongTaskIndex = await page.evaluate(() => window.__qaLongTasks.length);
  const start = await page.evaluate(() => performance.now());
  let peakHeapBytes = await heapUsed(cdp);
  let active = true;
  const sampler = (async () => {
    while (active) {
      try {
        peakHeapBytes = Math.max(peakHeapBytes, await heapUsed(cdp));
      } catch (_) {
        // Context shutdown is handled by the caller; keep the last valid sample.
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })();

  try {
    await action();
    await waitForCompletion();
  } finally {
    active = false;
    await sampler;
  }
  peakHeapBytes = Math.max(peakHeapBytes, await heapUsed(cdp));
  const end = await page.evaluate(() => performance.now());
  const longTasks = await page.evaluate(index => window.__qaLongTasks.slice(index), startLongTaskIndex);
  return {
    durationMs: round(end - start),
    peakHeapMb: round(peakHeapBytes / MB),
    maxLongTaskMs: round(longTasks.length ? Math.max(...longTasks.map(task => task.duration)) : 0),
    longTaskCount: longTasks.length
  };
}

async function runOnce(browser, fixtures) {
  const context = await browser.newContext(config.contextOptions);
  await context.addInitScript(() => {
    window.__qaLongTasks = [];
    if (typeof PerformanceObserver === 'function') {
      try {
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            window.__qaLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch (_) {
        // Missing longtask support is represented by an empty list.
      }
    }
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(config.timeouts.navigation);
  const cdp = await context.newCDPSession(page);
  await page.goto(pathToFileURL(config.htmlPath).href);

  try {
    const scan = await measurePhase(page, cdp,
      () => page.locator('#file-input').setInputFiles(fixtures.map(fixturePath)),
      () => page.waitForFunction(count => {
        const cards = Array.from(document.querySelectorAll('.doc-card'));
        return cards.length === count && cards.every(card => !card.textContent.includes('讀取解析中'));
      }, fixtures.length, { timeout: 70000 }));

    const clean = await measurePhase(page, cdp,
      () => page.locator('#btn-start-clean').click(),
      () => page.waitForFunction(count => document.querySelectorAll('.btn-download-one').length === count,
        fixtures.length, { timeout: 70000 }));

    return {
      scanMs: scan.durationMs,
      cleanMs: clean.durationMs,
      maxLongTaskMs: Math.max(scan.maxLongTaskMs, clean.maxLongTaskMs),
      peakHeapMb: Math.max(scan.peakHeapMb, clean.peakHeapMb),
      scanLongTaskCount: scan.longTaskCount,
      cleanLongTaskCount: clean.longTaskCount
    };
  } finally {
    await context.close();
  }
}

function summarizeRuns(name, fixtures, runs, budget) {
  const summary = {
    scanMedianMs: round(median(runs.map(run => run.scanMs))),
    scanWorstMs: round(Math.max(...runs.map(run => run.scanMs))),
    cleanMedianMs: round(median(runs.map(run => run.cleanMs))),
    cleanWorstMs: round(Math.max(...runs.map(run => run.cleanMs))),
    maxLongTaskMs: round(Math.max(...runs.map(run => run.maxLongTaskMs))),
    peakHeapMb: round(Math.max(...runs.map(run => run.peakHeapMb)))
  };
  const violations = [];
  if (summary.scanWorstMs > budget.scanMs) violations.push(`scan worst ${summary.scanWorstMs}ms > ${budget.scanMs}ms`);
  if (summary.cleanWorstMs > budget.cleanMs) violations.push(`clean worst ${summary.cleanWorstMs}ms > ${budget.cleanMs}ms`);
  if (summary.maxLongTaskMs > BUDGETS.maxLongTaskMs) violations.push(`long task ${summary.maxLongTaskMs}ms > ${BUDGETS.maxLongTaskMs}ms`);
  if (summary.peakHeapMb > BUDGETS.maxHeapMb) violations.push(`heap ${summary.peakHeapMb}MB > ${BUDGETS.maxHeapMb}MB`);
  return {
    name,
    inputFiles: fixtures.length,
    inputBytes: fixtures.reduce((sum, fixture) => sum + fs.statSync(fixturePath(fixture)).size, 0),
    runs,
    summary,
    budget: { ...budget, maxLongTaskMs: BUDGETS.maxLongTaskMs, maxHeapMb: BUDGETS.maxHeapMb },
    passed: violations.length === 0,
    violations
  };
}

async function runPerformanceTests() {
  const manifest = await generateFixtures();
  const scenarios = [
    {
      name: 'typical-eight-format-batch',
      fixtures: manifest.fixtures.filter(fixture => fixture.category === 'risky'),
      budget: BUDGETS.typical
    },
    {
      name: 'boundary-98mb-batch',
      fixtures: manifest.fixtures.filter(fixture => fixture.category === 'performance-boundary'),
      budget: BUDGETS.boundary
    }
  ];
  assert.equal(scenarios[0].fixtures.length, 8);
  assert.equal(scenarios[0].fixtures.filter(fixture => fixture.format === 'webp').length, 1);
  assert.equal(scenarios[1].fixtures.length, 6);
  assert.equal(scenarios[1].fixtures.filter(fixture => fixture.format === 'webp').length, 1);
  assert.equal(scenarios[1].fixtures.reduce((sum, fixture) => sum + fs.statSync(fixturePath(fixture)).size, 0), 98 * MB);

  const browser = await chromium.launch(config.launchOptions);
  const browserVersion = browser.version();
  const scenarioResults = [];
  try {
    for (const scenario of scenarios) {
      const runs = [];
      for (let iteration = 1; iteration <= RUN_COUNT; iteration++) {
        const result = await runOnce(browser, scenario.fixtures);
        runs.push({ iteration, ...result });
        console.log(`${scenario.name} ${iteration}/${RUN_COUNT}: scan=${result.scanMs}ms clean=${result.cleanMs}ms heap=${result.peakHeapMb}MB long=${result.maxLongTaskMs}ms`);
      }
      scenarioResults.push(summarizeRuns(scenario.name, scenario.fixtures, runs, scenario.budget));
    }
  } finally {
    await browser.close();
  }

  const cpus = os.cpus();
  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    runCount: RUN_COUNT,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      playwright: playwrightPackage.version,
      browser: `Chromium ${browserVersion}`,
      cpuModel: cpus.length ? cpus[0].model : 'unknown',
      logicalCpuCount: cpus.length,
      totalMemoryMb: round(os.totalmem() / MB),
      standaloneHtmlBytes: fs.statSync(config.htmlPath).size
    },
    limitations: [
      'The 98MB boundary scenario uses synthetic padded image fixtures, including WebP; results describe this local browser and are not a cross-device benchmark.'
    ],
    budgets: BUDGETS,
    scenarios: scenarioResults,
    passed: scenarioResults.every(scenario => scenario.passed)
  };
  const resultPath = path.join(config.resultsDir, 'performance-results.json');
  fs.mkdirSync(config.resultsDir, { recursive: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);

  for (const scenario of scenarioResults) {
    console.log(`${scenario.passed ? 'PASS' : 'FAIL'} ${scenario.name}: ${JSON.stringify(scenario.summary)}`);
    if (scenario.violations.length) console.log(`  ${scenario.violations.join('; ')}`);
  }
  console.log(resultPath);
  if (!report.passed) throw new Error('One or more performance budgets were exceeded');
  return report;
}

if (require.main === module) {
  runPerformanceTests().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = { BUDGETS, RUN_COUNT, runPerformanceTests };
