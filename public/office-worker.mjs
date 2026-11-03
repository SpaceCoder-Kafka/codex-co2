import { unpackOffice } from './office-preview.mjs';
self.onmessage = event => {
  try {
    const entries = unpackOffice(event.data);
    self.postMessage({ entries }, entries.map(([, bytes]) => bytes.buffer));
  } catch (error) { self.postMessage({ error: error.message || 'Office 解压失败' }); }
};
