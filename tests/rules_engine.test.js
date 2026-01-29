const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadScript(filePath, context) {
  const code = fs.readFileSync(filePath, 'utf8');
  vm.runInContext(code, context, { filename: filePath });
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

const repoRoot = path.resolve(__dirname, '..');
const context = { console };
context.window = context;
vm.createContext(context);

loadScript(path.join(repoRoot, 'Koha/Plugin/Cataloging/AutoPunctuation/js/rules_engine.js'), context);

const rulesPack = loadJson(path.join(repoRoot, 'Koha/Plugin/Cataloging/AutoPunctuation/rules/aacr2_baseline.json'));
const fixtures = loadJson(path.join(repoRoot, 'tests/fixtures/marc_punctuation_cases.json')).cases || [];
const rules = context.AACR2RulesEngine.loadRules(rulesPack, '{}');

let failed = 0;
fixtures.forEach(testCase => {
  context.AACR2RulesEngine.clearWarnings();
  const result = context.AACR2RulesEngine.validateField(testCase.input, {}, rules);
  const findings = result.findings || [];
  const expected = testCase.expected || {};

  const expectedKeys = Object.keys(expected);
  if (!expectedKeys.length && findings.length) {
    console.error(`FAIL ${testCase.id}: expected no findings, got ${findings.length}`);
    failed += 1;
    return;
  }

  expectedKeys.forEach(code => {
    const expectedValue = expected[code];
    const matched = findings.some(f => f.subfield === code && f.expected_value === expectedValue);
    if (!matched) {
      console.error(`FAIL ${testCase.id}: missing expected ${code} -> "${expectedValue}"`);
      failed += 1;
    }
  });

  const warnings = context.AACR2RulesEngine.getWarnings();
  const expectedWarnings = testCase.warnings || [];
  if (warnings.length !== expectedWarnings.length) {
    console.error(`FAIL ${testCase.id}: expected ${expectedWarnings.length} warning(s), got ${warnings.length}`);
    failed += 1;
  }
});

if (failed) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}

console.log(`OK ${fixtures.length} fixture(s) passed.`);
