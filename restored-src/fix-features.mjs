import fs from 'fs';
import path from 'path';

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(full));
    } else if (full.endsWith('.ts') || full.endsWith('.js') || full.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

const files = walk('src');
for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  
  // Remove all occurrences of the old const feature defs
  const constRegex = /^const feature = \(name: any\) => process\.env\[name\] === '1';\r?\n?/gm;
  const funcRegex = /^function feature\(name: any\) \{ return process\.env\[name\] === '1'; \}\r?\n?/gm;
  
  let newContent = content.replace(constRegex, "").replace(funcRegex, "");
  
  // If feature( is used in the file, append to bottom
  if (newContent.includes('feature(')) {
    newContent = newContent + "\n\nfunction feature(name: any) { return process.env[name] === '1'; }\n";
  }
  
  if (newContent !== content) {
    fs.writeFileSync(file, newContent, 'utf8');
  }
}
