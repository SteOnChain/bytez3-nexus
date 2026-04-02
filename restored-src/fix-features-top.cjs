const fs = require('fs')
const path = require('path')

const FEATURE_DEF = "const feature = (name: any) => process.env[name] === '1';"

function fixFile(fullPath) {
  let content = fs.readFileSync(fullPath, 'utf8')
  if (!content.includes("const feature = ")) return

  // Remove existing
  content = content.replace(new RegExp(FEATURE_DEF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n?', 'g'), '')
  content = content.replace(new RegExp("const feature = \\(name: any\\) => process.env\\[name\\] === '1';;\\r?\\n?", 'g'), '')
  
  // Insert at the top, but after shebang if present
  if (content.startsWith('#!')) {
    const lines = content.split('\n')
    lines.splice(1, 0, FEATURE_DEF)
    content = lines.join('\n')
  } else {
    content = FEATURE_DEF + '\n' + content
  }
  
  fs.writeFileSync(fullPath, content, 'utf8')
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
