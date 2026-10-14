const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'public', 'app.js');
let content = fs.readFileSync(filePath, 'utf8');

// The file has literal backslash-backtick sequences (\`) that break in browsers.
// Replace \` with just ` (template literal backtick)
// Also replace \${ with ${ (template literal expression start)
const fixed = content
  .split('\\`').join('`')
  .split('\\${').join('${');

fs.writeFileSync(filePath, fixed, 'utf8');

// Verify the fix
const after = fs.readFileSync(filePath, 'utf8');
const remaining = (after.match(/\\`/g) || []).length;
console.log(`Fixed. Remaining escaped backticks: ${remaining}`);
