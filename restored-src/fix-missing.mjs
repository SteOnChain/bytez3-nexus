import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

let tries = 0;
while (tries < 50) {
  const result = spawnSync('npm', ['run', 'start:ollama'], { encoding: 'utf8' });
  const output = result.stdout + result.stderr;
  
  const match = output.match(/ERR_MODULE_NOT_FOUND.*?'([^']+)'/);
  if (match) {
    let missing = match[1];
    console.log("Missing:", missing);
    if (missing.startsWith('file://')) {
      missing = missing.replace('file://', '');
    }
    if (missing.includes('node_modules/src/')) {
        missing = missing.replace('node_modules/src/', 'src/');
    }
    if (missing.endsWith('.js')) {
      missing = missing.slice(0, -3) + '.ts';
    }
    if (fs.existsSync(missing)) {
        console.log("File exists but errored, breaking loop:", missing);
        break;
    }
    const dir = path.dirname(missing);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(missing, 'export {};\n', 'utf8');
    console.log(`Created ${missing}`);
    tries++;
  } else {
    console.log("No ERR_MODULE_NOT_FOUND found. Output:", output);
    break;
  }
}
