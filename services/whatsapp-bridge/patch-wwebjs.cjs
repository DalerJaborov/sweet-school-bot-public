// Build-time patch for whatsapp-web.js 1.34.7 under WA Web 2.3000.105x (wwebjs issues #201921/#201922, PRs #201923/#201925).
// MediaData's private __x_id / id leak into the outgoing Msg via `...mediaOptions` and break the memoized getter
// ("Data passed to getter must include an id property"). Fails the build loudly if the anchor moved.
const fs = require('fs');
const file = require.resolve('whatsapp-web.js/src/util/Injected/Utils.js');
let src = fs.readFileSync(file, 'utf8');
const anchor = '            ...extraOptions,\n        };\n';
if (src.includes('__x_id')) { console.log('patch-wwebjs: already applied'); process.exit(0); }
if (!src.includes(anchor)) { console.error('patch-wwebjs: anchor not found'); process.exit(1); }
src = src.replace(anchor, anchor +
  '        // sweet-school patch: MediaData fields must not override the Msg id (wwebjs #201921).\n' +
  '        delete message.__x_id;\n' +
  '        message.id = newMsgKey;\n');
fs.writeFileSync(file, src);
console.log('patch-wwebjs: applied');
