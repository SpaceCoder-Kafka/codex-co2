import path from 'node:path';
import os from 'node:os';

// Check both the original attachment and its real path before any body read.
// Windows paths are case insensitive and must not open UNC/device/ADS paths.
export function protectedAttachmentPath(file, { allowVisualizations = false, platform = process.platform, home = os.homedir() } = {}) {
  const windows = platform === 'win32', paths = windows ? path.win32 : path.posix;
  if (typeof file !== 'string' || !paths.isAbsolute(file) || file.includes('\0')) return true;
  if (windows && (!/^[A-Za-z]:[\\/]/.test(file) || file.slice(2).includes(':')
    || file.split(/[\\/]/).slice(1).some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) return true;
  const normalize = value => { const normalized = paths.normalize(value); return windows ? normalized.toLowerCase() : normalized; };
  file = normalize(file); home = normalize(home);
  const within = root => file === root || file.startsWith(root + paths.sep);
  const codex = paths.join(home, '.codex');
  return within(codex) && !(allowVisualizations && within(paths.join(codex, 'visualizations')))
    || ['.ssh', '.aws', '.gnupg'].some(name => within(paths.join(home, name)))
    || file.split(paths.sep).includes('.coop')
    || ['auth.json', 'credentials.json', 'credentials'].includes(paths.basename(file).toLowerCase());
}
