import { exec } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

export async function launchBrowser() {
  const platform = os.platform();
  const userDataDir = path.join(os.homedir(), '.config', 'google-chrome', 'openclaw');
  
  // Construct absolute path to the extension directory
  const rootDir = process.cwd(); 
  const extensionPath = path.join(rootDir, 'extension');

  // Ensure the user data dir exists
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  let cmd = '';

  if (platform === 'linux') {
    // Try to find an available browser
    cmd = `google-chrome-stable --user-data-dir="${userDataDir}" --load-extension="${extensionPath}" --no-first-run --no-default-browser-check &`;
  } else if (platform === 'darwin') {
    // macOS
    cmd = `open -n -a "Google Chrome" --args --user-data-dir="${userDataDir}" --load-extension="${extensionPath}" --no-first-run --no-default-browser-check`;
  } else if (platform === 'win32') {
    // Windows 
    cmd = `start chrome --user-data-dir="${userDataDir}" --load-extension="${extensionPath}" --no-first-run --no-default-browser-check`;
  }

  return new Promise((resolve, reject) => {
    exec(cmd, (error) => {
      if (error && !error.message.includes('Command failed')) {
        // We log execution errors, but mostly the browser just detaches on linux
        console.warn('[Browser Launcher] Note:', error.message);
      }
      // Give the browser 3 seconds to boot and connect the websocket
      setTimeout(resolve, 3000);
    });
  });
}
