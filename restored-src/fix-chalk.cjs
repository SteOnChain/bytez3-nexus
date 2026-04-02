const fs = require('fs')
const path = require('path')

function replaceChalk(dir) {
  const files = fs.readdirSync(dir)
  for (const file of files) {
    const fullPath = path.join(dir, file)
    if (fs.statSync(fullPath).isDirectory()) {
      replaceChalk(fullPath)
    } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') || fullPath.endsWith('.js') || fullPath.endsWith('.jsx')) {
      let content = fs.readFileSync(fullPath, 'utf8')
      let changed = false
      if (content.includes("import chalk from 'chalk'") || content.includes('import chalk from "chalk"')) {
        content = content.replace(/import chalk from ['"]chalk['"]/g, 'import * as chalk from "chalk"')
        changed = true
      }
      if (changed) {
        fs.writeFileSync(fullPath, content, 'utf8')
      }
    }
  }
}

replaceChalk(path.join(__dirname, 'src'))
console.log('Fixed chalk imports')
