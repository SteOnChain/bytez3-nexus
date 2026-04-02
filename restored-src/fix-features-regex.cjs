const fs = require('fs')
const path = require('path')

const FEATURE_DEF = "const feature = (name: any) => process.env[name] === '1';"
const SEMI_FEATURE_DEF = "const feature = (name: any) => process.env[name] === '1';;"

function fixFile(fullPath) {
  let content = fs.readFileSync(fullPath, 'utf8')
  if (!content.includes("const feature = ")) return

  // Remove all instances of the feature definition
  content = content.replace(new RegExp(FEATURE_DEF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')
  content = content.replace(new RegExp(SEMI_FEATURE_DEF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '')
  
  // Clean up any double empty lines that might have been left
  content = content.replace(/\n\s*\n\s*\n/g, '\n\n')

  // Find the right place to insert it (after imports)
  // Or just insert it at the top, after any 'use strict' or imports
  // But wait, in ESM or TS, placing it at the very top is fine because imports are hoisted.
  // Actually, ESLint might complain if it's placed before imports if style rules enforce it.
  // We can just place it after the last import statement
  
  const lines = content.split('\n')
  let lastImportIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('import ') || (lines[i].startsWith('const require') && !lines[i].includes('import.meta')) || lines[i].startsWith('/* eslint-enable')) {
       lastImportIdx = i;
    }
  }
  
  lines.splice(Math.max(0, lastImportIdx + 1), 0, "const feature = (name: any) => process.env[name] === '1';")
  
  fs.writeFileSync(fullPath, lines.join('\n'), 'utf8')
}

function processDir(dir) {
  const files = fs.readdirSync(dir)
  for (const file of files) {
    const fullPath = path.join(dir, file)
    if (fs.statSync(fullPath).isDirectory()) {
      processDir(fullPath)
    } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') || fullPath.endsWith('.js')) {
      fixFile(fullPath)
    }
  }
}

processDir(path.join(__dirname, 'src'))
console.log('Fixed feature definitions')
