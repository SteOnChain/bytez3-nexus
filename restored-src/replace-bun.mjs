import fs from 'fs';
import path from 'path';

function walk(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory() && file.name !== 'node_modules') {
      walk(fullPath);
    } else if (file.name.endsWith('.ts') || file.name.endsWith('.tsx') || file.name.endsWith('.js')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes("from 'bun:bundle'")) {
        content = content.replace(/import\s+\{\s*feature\s*\}\s+from\s+['"]bun:bundle['"]/g, "const feature = (name: any) => process.env[name] === '1';");
        fs.writeFileSync(fullPath, content);
        console.log('Fixed', fullPath);
      }
    }
  }
}

walk('./src');
console.log('Done replacing bun:bundle');
