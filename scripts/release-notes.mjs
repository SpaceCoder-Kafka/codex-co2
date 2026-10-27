import fs from 'node:fs/promises';
import path from 'node:path';

// Both platform builds use the same English entry and its Chinese language link.
// Checksums and source inventories accompany assets, outside the release body.
export async function releaseNotes({ root, release }) {
  const changelog = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const heading = `## ${release.version}\n`;
  const start = changelog.indexOf(heading);
  if (start < 0) throw new Error(`Add a CHANGELOG entry for ${release.version} before building a release`);
  const entry = changelog.slice(start + heading.length).split('\n## ')[0].trim();
  return `${entry}\n`;
}
