// Local-manager projection only. No names, titles, message text or capabilities
// enter the native notification pipe or the macOS notification store.
export function attentionFor({ rooms = [], connection = {}, recoveryRequests = [] }) {
  const items = [];
  const add = (kind, roomId, members, itemId = members[0]) => {
    if (members.length) items.push({ id: `${roomId || 'manager'}:${kind}`, kind, roomId, members, itemId, count: members.length });
  };
  const networkDown = ['unavailable', 'stopped'].includes(connection.state);
  if (networkDown && rooms.some(r => r.state !== 'revoked' || r.endReason === 'paused')) add('connection', '', [connection.state]);
  const recoveryGroups = new Map();
  for (const request of recoveryRequests) {
    if (!['pending', 'failed'].includes(request.status)) continue;
    const members = recoveryGroups.get(request.roomId) ?? [];
    members.push(request.requestId); recoveryGroups.set(request.roomId, members);
  }
  for (const [roomId, members] of recoveryGroups) add('invite-recovery', roomId, members);
  for (const room of rooms) {
    if (room.state === 'revoked') {
      if ((room.lastError || room.endReason === 'expired') && !rooms.some(r => r.threadId === room.threadId && r.state !== 'revoked')) {
        add('share-stopped', room.roomId, ['stopped']);
      }
      continue;
    }
    if (room.state === 'online') {
      add('guest', room.roomId, room.guests.filter(g => g.status === 'pending').map(g => g.id));
      add('proposal', room.roomId, room.proposals.filter(p => p.status === 'pending').map(p => p.id));
      if (room.approvalPending) add('tool', room.roomId, ['tool']);
    }
    add('unknown', room.roomId, room.proposals.filter(p => p.status === 'unknown').map(p => p.id));
    if (room.state === 'offline' && !networkDown) add('offline', room.roomId, ['offline']);
  }
  return items;
}
