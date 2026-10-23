import base64
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('notices', Path(__file__).resolve().parents[1] / 'scripts/collect-cloudflared-notices.py')
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


def encoded(value):
    length, prefix = len(value), bytearray()
    while length >= 128:
        prefix.append((length & 127) | 128)
        length >>= 7
    return bytes(prefix + bytes([length])) + value


class NoticeTests(unittest.TestCase):
    def test_embedded_versions_include_module_replacements(self):
        text = b'dep\texample.invalid/original\tv1.0.0\n=>\texample.invalid/replacement\tv2.0.0\th1:synthetic\n'
        header = b'\xff Go buildinf:' + bytes([8, 2]) + bytes(16)
        binary = header + encoded(b'go1.27.1') + encoded(bytes(16) + text + bytes(16))
        version, modules = notices.build_info(binary)
        self.assertEqual(version, 'go1.27.1')
        self.assertEqual(modules[0]['module'], 'example.invalid/replacement')
        self.assertEqual(modules[0]['replaces'], 'example.invalid/original')
        with self.assertRaises(ValueError):
            notices.build_info(header + encoded(b'go1.27.1') + encoded(b'bad framing'))

    def test_source_checksums_are_verified_before_license_output(self):
        files = {'example.invalid/module@v1.0.0/LICENSE': b'Full synthetic license', 'example.invalid/module@v1.0.0/NOTICE': b'Full copyright notice'}
        summary = b''.join(hashlib.sha256(content).hexdigest().encode() + b'  ' + name.encode() + b'\n' for name, content in sorted(files.items()))
        checksum = 'h1:' + base64.b64encode(hashlib.sha256(summary).digest()).decode()
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as target:
            for name, content in files.items():
                target.writestr(name, content)
        with tempfile.TemporaryDirectory() as temporary, patch.object(notices, 'fetch', return_value=archive.getvalue()):
            root = Path(temporary)
            entry = {'module': 'example.invalid/module', 'version': 'v1.0.0', 'sum': checksum}
            result = notices.collect_module(entry, root, root / 'valid')
            self.assertEqual(len(result['notices']), 2)
            self.assertIn('example.invalid/module/v1.0.0/LICENSE', result['notices'])
            self.assertTrue(all('\\' not in name for name in result['notices']))
            self.assertEqual((root / 'valid/example.invalid/module/v1.0.0/LICENSE').read_bytes(), b'Full synthetic license')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                notices.collect_module({**entry, 'sum': 'h1:invalid'}, root, root / 'invalid')
            self.assertFalse((root / 'invalid').exists())

    def test_module_paths_cannot_escape_output(self):
        with self.assertRaisesRegex(ValueError, 'Unsafe module'):
            notices.collect_module({'module': '../escape', 'version': 'v1.0.0', 'sum': 'h1:synthetic'}, Path('.'), Path('.'))


if __name__ == '__main__':
    unittest.main()
