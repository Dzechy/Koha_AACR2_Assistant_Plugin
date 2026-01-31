const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadScript(filePath, context) {
  const code = fs.readFileSync(filePath, 'utf8');
  vm.runInContext(code, context, { filename: filePath });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    console.error(`FAIL ${message}: expected "${expected}", got "${actual}"`);
    return 1;
  }
  return 0;
}

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    console.error(`FAIL ${message}: expected ${b}, got ${a}`);
    return 1;
  }
  return 0;
}

const repoRoot = path.resolve(__dirname, '..');
const context = { console };
context.window = context;
vm.createContext(context);

loadScript(path.join(repoRoot, 'Koha/Plugin/Cataloging/AutoPunctuation/js/marc_intellisense_ui.js'), context);

const hooks = context.AACR2IntellisenseTestHooks;
if (!hooks) {
  console.error('FAIL AACR2IntellisenseTestHooks not found.');
  process.exit(1);
}

let failed = 0;

failed += assertEqual(
  hooks.buildTitleSourceFromParts('Title', 'Subtitle', 'Author'),
  'Title Subtitle Author',
  'buildTitleSourceFromParts joins a/b/c with spaces'
);
failed += assertEqual(
  hooks.buildTitleSourceFromParts(' Title ', '', 'Author'),
  'Title Author',
  'buildTitleSourceFromParts trims and skips empty parts'
);
failed += assertEqual(
  hooks.buildTitleSourceFromParts('Title', ': subtitle', ''),
  'Title : subtitle',
  'buildTitleSourceFromParts preserves raw punctuation'
);

const filtered = hooks.filterCatalogingSubfields([
  { code: 'b', value: 'Subtitle' },
  { code: 'a', value: 'Title' },
  { code: 'c', value: 'Author' },
  { code: 'd', value: 'Ignore' },
  { code: 'b', value: 'Second subtitle' }
]);
failed += assertDeepEqual(
  filtered,
  [
    { code: 'b', value: 'Subtitle' },
    { code: 'a', value: 'Title' },
    { code: 'c', value: 'Author' },
    { code: 'd', value: 'Ignore' },
    { code: 'b', value: 'Second subtitle' }
  ],
  'filterCatalogingSubfields preserves subfields in order and repeats'
);

const subjectFindings = [
  { code: 'AI_SUBJECTS', message: 'Subjects: Cats; Dogs\nBirds | Fish' }
];
failed += assertDeepEqual(
  hooks.parseAiSubjects(subjectFindings),
  ['Cats', 'Dogs', 'Birds', 'Fish'],
  'parseAiSubjects splits on semicolons, newlines, and pipes'
);

const subdivisionFindings = [
  { code: 'AI_SUBJECTS', message: 'Subjects: Cats -- Behavior, Care; Dogs' }
];
failed += assertDeepEqual(
  hooks.parseAiSubjects(subdivisionFindings),
  ['Cats -- Behavior, Care', 'Dogs'],
  'parseAiSubjects avoids splitting commas inside subdivisions'
);

const commaListFindings = [
  { code: 'AI_SUBJECTS', message: 'Subjects: Cats, Dogs, Birds' }
];
failed += assertDeepEqual(
  hooks.parseAiSubjects(commaListFindings),
  ['Cats', 'Dogs', 'Birds'],
  'parseAiSubjects splits clearly separated commas'
);

const singleCommaFindings = [
  { code: 'AI_SUBJECTS', message: 'Subjects: Cats, Dogs' }
];
failed += assertDeepEqual(
  hooks.parseAiSubjects(singleCommaFindings),
  ['Cats', 'Dogs'],
  'parseAiSubjects splits single-word comma lists'
);

const noSplitCommaFindings = [
  { code: 'AI_SUBJECTS', message: 'Subjects: United States, Congress' }
];
failed += assertDeepEqual(
  hooks.parseAiSubjects(noSplitCommaFindings),
  ['United States, Congress'],
  'parseAiSubjects avoids splitting headings with internal commas'
);

failed += assertEqual(
  hooks.buildPluginUrl({ pluginPath: '/cgi-bin/koha/plugins/run.pl?class=Test' }, 'guide_progress_update'),
  '/cgi-bin/koha/plugins/run.pl?class=Test&method=guide_progress_update',
  'buildPluginUrl appends method'
);

const classificationFindings = [
  { code: 'AI_CLASSIFICATION', message: 'Classification: QA 76.73.' }
];
failed += assertEqual(
  hooks.parseAiClassification(classificationFindings),
  'QA 76.73',
  'parseAiClassification strips prefix and trailing punctuation'
);

const callNumberFindings = [
  { code: 'OTHER', message: 'Call number: PS 3553.A789' }
];
failed += assertEqual(
  hooks.parseAiClassification(callNumberFindings),
  'PS 3553.A789',
  'parseAiClassification accepts call number prefix'
);

if (failed) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}

console.log('OK ui_helpers tests passed.');
