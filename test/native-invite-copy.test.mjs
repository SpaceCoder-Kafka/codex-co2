import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SharedRoom, secret } from '../lib/host.mjs';
import { GuestPermissions } from '../lib/guest-permissions.mjs';

test('native invitation copying accepts LAN HTTP and public HTTPS, reports the real result and preserves the clipboard on invalid requests', { skip: process.platform !== 'darwin' }, async () => {
  // Execute the production Swift helper against a private named pasteboard.
  // Never read or overwrite the user's general clipboard or a real invitation.
  const source = await fs.readFile(new URL('../macos/App.swift', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('struct InvitationClipboard {'), source.indexOf('struct AttentionLedger {'));
  assert.ok(helper.startsWith('struct InvitationClipboard {'));
  const producedInvite = new SharedRoom({ relayUrl: 'http://127.0.0.1:35000', inviteOrigin: 'http://192.168.40.20:35001', intranetOnly: true,
    threadId: 'synthetic-native-copy', registrationSecret: secret(), permissions: new GuestPermissions() }).view().inviteUrl;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'co2-native-invite-copy-'));
  try {
    const file = path.join(dir, 'test.swift');
    await fs.writeFile(file, 'import AppKit\n' + helper + `
let board = NSPasteboard(name: NSPasteboard.Name("co2-synthetic-copy-" + UUID().uuidString))
defer { board.releaseGlobally() }
let token = String(repeating: "A", count: 43)
let fragment = "room=123e4567-e89b-42d3-a456-426614174000&invite=" + token
let scope = "123e4567-e89b-42d3-a456-426614174001"
let hosts = ["https://synthetic.example/", "http://192.168.40.20:35001/", "http://10.5.0.20:8080/", "http://172.16.40.20:8080/", "http://172.31.1.2:8080/"]
for (index, host) in hosts.enumerated() {
    let url = host + "#" + fragment + "&scope=" + scope
    let result = InvitationClipboard.response(to: ["requestId": "copy-" + String(index + 1), "url": url], board: board)!
    precondition(result["requestId"] as? String == "copy-" + String(index + 1))
    precondition(result["ok"] as? Bool == true)
    precondition(board.string(forType: .string) == url)
}
precondition(InvitationClipboard.accepts("https://synthetic.example/#room=old_room-123&invite=" + token))
let invalid = [
    "http://203.0.113.1:8080/#" + fragment,
    "http://127.0.0.1:8080/#" + fragment,
    "http://100.64.0.1:8080/#" + fragment,
    "http://172.32.0.1:8080/#" + fragment,
    "http://192.168.040.20:8080/#" + fragment,
    "http://%31%39%32.168.40.20:8080/#" + fragment,
    "http://3232245780:8080/#" + fragment,
    "http://[fd00::1]:8080/#" + fragment,
    "http://internal.example:8080/#" + fragment,
    "http://192.168.40.20/#" + fragment,
    "http://192.168.40.20:0/#" + fragment,
    "http://192.168.40.20:65536/#" + fragment,
    ["https://", "synthetic-user:synthetic-password@", "synthetic.example/#"].joined() + fragment,
    "https://synthetic.example/path#" + fragment,
    "https://synthetic.example/?invite=untrusted#" + fragment,
    "https://synthetic.example/#" + fragment + "&invite=" + token,
    "https://synthetic.example/#" + fragment + "&extra=value",
    "https://synthetic.example/#room=missing-token",
    "https://synthetic.example/#invite=" + token,
    "https://synthetic.example/#room=12345678&invite=invalid",
    "https://synthetic.example/#" + fragment + "&scope=invalid%20scope",
    "https://synthetic.example/#" + fragment + "&scope=",
    "https://synthetic.example/#" + fragment + "\\n",
    "file:///tmp/#" + fragment,
    String(repeating: "A", count: 4096)
]
for url in invalid {
    board.clearContents(); precondition(board.setString("synthetic sentinel", forType: .string))
    let result = InvitationClipboard.response(to: ["requestId": "copy-99", "url": url], board: board)!
    precondition(result["ok"] as? Bool == false)
    precondition(board.string(forType: .string) == "synthetic sentinel")
}
let validURL = hosts[1] + "#" + fragment
let producedURL = ${JSON.stringify(producedInvite)}
precondition(InvitationClipboard.copy(producedURL, to: board))
precondition(board.string(forType: .string) == producedURL)
precondition(InvitationClipboard.response(to: ["requestId": "copy-100", "url": validURL, "extra": true], board: board)!["ok"] as? Bool == false)
precondition(InvitationClipboard.response(to: ["requestId": "copy-101", "url": 123], board: board)!["ok"] as? Bool == false)
precondition(InvitationClipboard.response(to: ["requestId": "copy-0", "url": validURL], board: board) == nil)
precondition(InvitationClipboard.response(to: ["requestId": "unsafe\\\"id", "url": validURL], board: board) == nil)
precondition(InvitationClipboard.response(to: validURL, board: board) == nil)
print("native invitation copy passed")
`);
    assert.equal(execFileSync('/usr/bin/swift', [file], { encoding: 'utf8', timeout: 30000 }).trim(), 'native invitation copy passed');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
