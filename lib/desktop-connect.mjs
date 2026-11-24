import { attachDesktop, DesktopIpc } from './desktop-ipc.mjs';
import { createDesktopUploadHistory } from './desktop-upload-history.mjs';
import { createDesktopAppLauncher } from './desktop-app-launcher.mjs';

// The new path uses a Desktop-started MCP App for reads and the official
// persistent queue for writes. Only Desktop executes the shared conversation.
export async function attachDesktopCompatible(options = {}) {
  try {
    const attachment = await attachDesktop(options);
    attachment.reconnect = async () => { const ipc = await DesktopIpc.connect(options.endpoint); ipc.close(); };
    return attachment;
  }
  catch (error) {
    if (process.platform !== 'darwin' || options.endpoint !== undefined || !options.runtimeDir || !options.resourceRoot
      || error.code !== 'DESKTOP_IPC_UNAVAILABLE' || !['ENOENT', 'ECONNREFUSED'].includes(error.systemCode)) throw error;
  }
  const [{ createDesktopAppBridge }, { attachDesktopApp }, { createDesktopQueue }] = await Promise.all([
    import('./desktop-app-bridge.mjs'), import('./desktop-app-adapter.mjs'), import('./desktop-queue.mjs'),
  ]);
  const launcher = await createDesktopAppLauncher(options);
  const bridge = await createDesktopAppBridge({ runtimeDir: options.runtimeDir });
  const queue = createDesktopQueue({ cliPath: launcher.cliPath, wakeThread: id => launcher.wakeThread(id) });
  try {
    const attachment = await attachDesktopApp({ bridge, queue, catalog: options.catalog,
      uploadHistory: createDesktopUploadHistory(options.runtimeDir), ensureInstalled: launcher.ensureInstalled, launchBridge: launcher.openBridge });
    attachment.isCurrent = async () => await launcher.isInstalled() && bridge.connected;
    Object.defineProperty(attachment, 'desktopInfo', { get: () => ({ transport: 'desktop-app-tools', connected: bridge.connected,
      capabilities: attachment.capabilities }) });
    const reconnect = attachment.reconnect.bind(attachment);
    attachment.reconnect = async () => { await reconnect(); await queue.wakePending(); };
    const close = attachment.close.bind(attachment); let closing;
    attachment.close = () => closing ??= Promise.all([close(), queue.close(), bridge.close()]).then(() => {});
    return attachment;
  } catch (error) { await Promise.all([queue.close(), bridge.close()]); throw error; }
}
