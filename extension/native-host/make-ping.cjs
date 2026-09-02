const fs = require('fs');
const ping = Buffer.from(JSON.stringify({ type: 'ping' }));
const frame = Buffer.alloc(4 + ping.length);
frame.writeUInt32LE(ping.length, 0);
ping.copy(frame, 4);
fs.writeFileSync('ping-frame.bin', frame);
console.log('wrote ping-frame.bin', frame.length);
