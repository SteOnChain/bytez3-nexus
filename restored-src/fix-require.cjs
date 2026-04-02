const fs = require('fs');
const path = require('path');

function walkDir(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walkDir(file));
    } else {
      if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) {
        results.push(file);
      }
    }
  });
  return results;
}

const files = walkDir('./src');
let fixed = 0;

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes('require(') && !content.includes('createRequire(import.meta.url)')) {
    let lines = content.split('\n');
    const toInsertImports = "import { createRequire } from 'module';";
    const toInsertDecl = "const require = createRequire(import.meta.url);";
    
    // Safety: just prepend
    if (lines[0] && lines[0].startsWith('#!')) {
      lines.splice(1, 0, toInsertImports, toInsertDecl);
    } else {
      lines.unshift(toInsertImports, toInsertDecl);
    }
    
    fs.writeFileSync(file, lines.join('\n'));
    fixed++;
  }
}
console.log('Fixed', fixed, 'files with top insertion');
