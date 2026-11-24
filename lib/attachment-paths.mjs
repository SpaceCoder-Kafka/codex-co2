import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { storedGuestUploadPath } from './guest-uploads.mjs';

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
  const visualization = allowVisualizations && within(paths.join(home, '.codex', 'visualizations'));
  // Protect case aliases on macOS without widening its visualization exception
  // on case-sensitive volumes.
  if (platform === 'darwin') { file = file.toLowerCase(); home = home.toLowerCase(); }
  return within(paths.join(home, '.codex')) && !visualization
    || ['.ssh', '.aws', '.gnupg'].some(name => within(paths.join(home, name)))
    || file.split(paths.sep).includes('.coop') && !storedGuestUploadPath(file)
    || ['auth.json', 'credentials.json', 'credentials'].includes(paths.basename(file).toLowerCase()) && !storedGuestUploadPath(file);
}

// Runtime paths can have a system alias above .coop (such as /tmp on macOS).
// Every component inside the private upload tree must still name the original file.
export async function resolveAttachmentPath(source) {
  const resolved = await fs.realpath(source);
  if (storedGuestUploadPath(source)) {
    const runtime = path.resolve(source, '../../../..');
    const root = await fs.realpath(runtime);
    if (path.basename(root) !== '.coop' || resolved !== path.join(root, path.relative(runtime, source))) {
      throw new Error('Uploaded attachment path changed');
    }
  }
  return resolved;
}
