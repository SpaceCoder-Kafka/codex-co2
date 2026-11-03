import fs from 'node:fs/promises';
import path from 'node:path';

// npm creates executable shims at every dependency nesting level. They are
// build-time entry points; the packaged service resolves library modules.
export async function removeDependencyBins(nodeModules) {
  const root = path.resolve(nodeModules);
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.basename(root) !== 'node_modules') throw new Error('Expected a regular node_modules directory');
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (path.basename(directory) === 'node_modules' && entry.name === '.bin') {
        await fs.rm(file, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        // Do not follow package links. Any links outside .bin remain for the
        // bundle inventory to reject rather than broadening this cleanup.
        const current = await fs.lstat(file);
        if (current.isDirectory() && !current.isSymbolicLink()) await visit(file);
      }
    }
  }
  await visit(root);
}
