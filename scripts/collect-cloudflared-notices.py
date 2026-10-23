"""Collect notices for the exact modules embedded in a Go executable.

Build-info format: https://go.dev/src/debug/buildinfo/buildinfo.go
Module checksum format: https://go.dev/src/cmd/vendor/golang.org/x/mod/sumdb/dirhash/hash.go
No Go toolchain, credentials or arbitrary archive extraction are required.
"""
from pathlib import Path, PurePosixPath
from concurrent.futures import ThreadPoolExecutor
import base64
import hashlib
import io
import json
import re
import sys
import subprocess
import shutil
import urllib.parse
import zipfile


def decode_string(data):
    length = 0
    for offset, byte in enumerate(data[:10]):
        length |= (byte & 127) << (7 * offset)
        if byte < 128:
            start = offset + 1
            if length > len(data) - start:
                raise ValueError('Truncated Go build information')
            return data[start:start + length], data[start + length:]
    raise ValueError('Invalid Go build information length')


def build_info(data):
    magic = b'\xff Go buildinf:'
    start = data.index(magic)
    if data[start + 15] & 2 == 0:
        raise ValueError('Unsupported pointer-based Go build information')
    version, rest = decode_string(data[start + 32:])
    modules, _ = decode_string(rest)
    # The Go linker frames the module text with two 16-byte markers.
    if len(modules) < 32 or modules[-17] != 10:
        raise ValueError('Invalid module information framing')
    entries = []
    for line in modules[16:-16].decode('utf-8').splitlines():
        fields = line.split('\t')
        if fields[0] in ('dep', '=>'):
            if len(fields) < 3:
                raise ValueError('Incomplete Go module metadata')
            entry = dict(zip(('module', 'version', 'sum'), fields[1:4] + ['']))
            if fields[0] == 'dep':
                entries.append(entry)
            else:
                if not entries:
                    raise ValueError('Orphan module replacement')
                entry['replaces'] = entries[-1]['module']
                entries[-1] = entry
    if not entries or not re.fullmatch(r'go1\.\d+\.\d+', version.decode()):
        raise ValueError('Unsupported or missing Go module/version information')
    return version.decode(), entries


def fetch(url, cache):
    target = cache / hashlib.sha256(url.encode()).hexdigest()
    if not target.exists():
        temporary = target.with_suffix('.download')
        # Bound total transfer time, not just each socket read. Use the same
        # platform TLS/download tool as the macOS build script.
        curl = shutil.which('curl.exe' if sys.platform == 'win32' else 'curl')
        if not curl:
            raise RuntimeError('An HTTPS-capable curl executable is required to collect verified notices')
        subprocess.run([curl, '--fail', '--location', '--silent', '--show-error',
                        '--connect-timeout', '15', '--max-time', '120', '--retry', '2',
                        '--retry-max-time', '180', '--max-filesize', '268435456',
                        '--output', str(temporary), url], check=True, timeout=200)
        temporary.replace(target)
    return target.read_bytes()


def collect_module(entry, cache, destination):
    module, version, expected = (entry[key] for key in ('module', 'version', 'sum'))
    if not re.fullmatch(r'[A-Za-z0-9._~+/-]+', module) or '..' in module.split('/') or not re.fullmatch(r'v[0-9][A-Za-z0-9.+-]*', version):
        raise ValueError('Unsafe module identifier')
    if not expected.startswith('h1:'):
        raise ValueError('Module checksum unavailable: ' + module)
    escaped = ''.join('!' + c.lower() if c.isupper() else c for c in module)
    url = 'https://proxy.golang.org/' + urllib.parse.quote(escaped, safe='/!') + '/@v/' + urllib.parse.quote(version, safe='') + '.zip'
    archive = fetch(url, cache)
    notices = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        entries = [f for f in source.infolist() if not f.is_dir()]
        names = [f.filename for f in entries]
        if len(names) != len(set(names)):
            raise ValueError('Duplicate module archive paths')
        summary = hashlib.sha256()
        texts = {}
        for name in sorted(names):
            prefix = module + '@' + version + '/'
            if '\n' in name or not name.startswith(prefix):
                raise ValueError('Unexpected module archive path')
            relative = name[len(prefix):]
            parts = PurePosixPath(relative).parts
            if '..' in parts or not parts or relative.startswith('/'):
                raise ValueError('Unsafe module member')
            content = source.read(name)
            digest = hashlib.sha256(content).hexdigest()
            summary.update((digest + '  ' + name + '\n').encode())
            if re.match(r'^(licen[cs]e|copying|notice)([._-].*)?$', parts[-1], re.I) or 'LICENSES' in parts:
                if len(content) > 2 * 1024 * 1024:
                    raise ValueError('Notice too large')
                texts[relative] = content
        actual = 'h1:' + base64.b64encode(summary.digest()).decode()
        if actual != expected:
            raise ValueError('Module checksum mismatch: ' + module)
        if not texts:
            raise ValueError('No license found for embedded module: ' + module)
        for relative, content in texts.items():
            target = destination / module / version / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            notices[str(target.relative_to(destination))] = hashlib.sha256(content).hexdigest()
    return {**entry, 'source': url, 'notices': notices}


def main():
    binary, cache, destination = map(Path, sys.argv[1:4])
    cache.mkdir(parents=True, exist_ok=True)
    destination.mkdir(parents=True, exist_ok=True)
    version, modules = build_info(binary.read_bytes())
    license_url = 'https://raw.githubusercontent.com/golang/go/' + version + '/LICENSE'
    license_text = fetch(license_url, cache)
    if b'Copyright' not in license_text or b'<html' in license_text.lower():
        raise ValueError('Expected Go license text, not an HTML page')
    (destination / 'Go-LICENSE').write_bytes(license_text)
    with ThreadPoolExecutor(max_workers=4) as pool:
        collected = list(pool.map(lambda entry: collect_module(entry, cache, destination), modules))
    notices = {'Go-LICENSE': hashlib.sha256(license_text).hexdigest()}
    for entry in collected:
        notices.update(entry['notices'])
    (destination / 'index.json').write_text(json.dumps({'goVersion': version, 'modules': collected, 'files': notices}, indent=2) + '\n')
    print(f'Collected {len(modules)} embedded Go modules and {len(notices)} license/notice files')


if __name__ == '__main__':
    main()
