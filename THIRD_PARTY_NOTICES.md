# Third-party notices

The project MIT license does not replace third-party licenses. The lockfile and release manifest identify distributed versions.

| npm component | Version | Declared license |
| --- | --- | --- |
| argparse | 3.0.3 | PSF-2.0 |
| entities | 8.1.0 | BSD-2-Clause |
| linkify-it | 6.1.0 | MIT |
| markdown-it | 15.0.3 | MIT |
| mdurl | 2.1.0 | MIT |
| punycode.js | 2.3.1 | MIT |
| uc.micro | 3.0.0 | MIT |
| ws | 8.22.0 | MIT |

Full npm copyright and license texts are preserved in [third-party/npm-NOTICES.txt](third-party/npm-NOTICES.txt), generated from locked packages. Original licenses remain beside installed package code in the app.

The macOS preview also distributes **Node.js 22.23.3** and **cloudflared 2026.10.1**. `Contents/Resources/Licenses/` contains the project license, npm notices, Node's full bundled license (including third-party terms), cloudflared's Apache-2.0 license, the matching Go toolchain license, and license/notice texts from the exact module versions embedded in the cloudflared binary (including replacements). Module source archives are checked against their embedded Go h1 checksums before collecting notices. Supplemental module notices may cover code not linked into this platform's executable. Executables are re-signed ad hoc for this preview; their code is not patched by the build.

Build-only Python tools (`dmgbuild`, `ds_store`, `mac_alias`) are pinned with hashes in `scripts/requirements-macos.txt`; their code is not bundled. The installer compatibility workaround refers to [dmgbuild #275](https://github.com/dmgbuild/dmgbuild/pull/275).

Official sources: [Node license](https://github.com/nodejs/node/blob/v22.23.3/LICENSE), [cloudflared license](https://github.com/cloudflare/cloudflared/blob/2026.10.1/LICENSE), [Go license](https://go.dev/LICENSE). Retain licenses and applicable notices when redistributing. See [asset provenance](ASSET_PROVENANCE.md) for project visuals.
