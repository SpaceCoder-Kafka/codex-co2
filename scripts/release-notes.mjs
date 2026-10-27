import fs from 'node:fs/promises';
import path from 'node:path';

// Both platform builds publish the same user-facing release entry. Detailed
// acceptance records belong outside the public release notes.
export async function releaseNotes({ root, release, sourceSHA256 }) {
  const changelog = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const heading = `## ${release.version}\n`;
  const start = changelog.indexOf(heading);
  if (start < 0) throw new Error(`Add a CHANGELOG entry for ${release.version} before building a release`);
  const entry = changelog.slice(start + heading.length).split('\n## ')[0].trim();
  const preview = release.channel === 'preview' ? ' Preview' : '';
  return `# Codex Co² ${release.version}${preview}\n\nBuild ${release.build} · ${release.channel}\n\n${entry}\n\nSource SHA-256: \`${sourceSHA256}\`. Checksums and matching source inventories accompany the installation files. Third-party license notices are included in the application.\n`;
}
