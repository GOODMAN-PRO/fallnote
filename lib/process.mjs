import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export function run(command, args, { cwd, signal, onOutput, maxOutput = 200000, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', data => {
      stdout = (stdout + data).slice(-maxOutput);
      onOutput?.(String(data), 'stdout');
    });
    child.stderr.on('data', data => {
      stderr = (stderr + data).slice(-maxOutput);
      onOutput?.(String(data), 'stderr');
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (signal?.aborted) return reject(new Error('Cancelled.'));
      if (timedOut) return reject(new Error(`${command} timed out.`));
      if (code !== 0) {
        const lines = (stderr || stdout).trim().split(/\r?\n/);
        const terminal = lines.filter(line => /ERROR:/i.test(line)).at(-1);
        return reject(new Error(terminal || lines.slice(-5).join('\n') || `${command} exited with code ${code}.`));
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function available(command, args = ['--version']) {
  try { await run(command, args, { timeout: 10000 }); return true; } catch { return false; }
}

// Startup must not wait on external tools or network authentication. Check PATH;
// the operation itself reports version/authentication errors when it runs.
export async function executablePresent(command) {
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      try { await access(join(directory.replace(/^"|"$/g, ''), command + extension)); return true; } catch {}
    }
  }
  return false;
}
