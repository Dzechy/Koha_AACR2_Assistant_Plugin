const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const files = [
  path.join(repoRoot, 'Koha/Plugin/Cataloging/AutoPunctuation/js/api_client.js'),
  path.join(repoRoot, 'Koha/Plugin/Cataloging/AutoPunctuation/js/marc_intellisense_ui.js'),
  path.join(repoRoot, 'Koha/Plugin/Cataloging/AutoPunctuation.pm')
];

const forbidden = [
  'aiClientKeyObfuscated',
  'aiClientKeySeed',
  'decodeObfuscatedSecret'
];

let failed = 0;
files.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  forbidden.forEach(token => {
    if (content.includes(token)) {
      console.error(`FAIL ${path.basename(file)} contains ${token}`);
      failed += 1;
    }
  });
});

if (failed) {
  console.error(`\n${failed} security test(s) failed.`);
  process.exit(1);
}

console.log('OK security tests passed.');
