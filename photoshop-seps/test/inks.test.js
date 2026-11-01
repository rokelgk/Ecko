'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { inks } = require('../engine');

function makeAse(colors) {
  const blocks = colors.map(([name, rgb]) => {
    const nameBuf = Buffer.alloc((name.length + 1) * 2);
    for (let i = 0; i < name.length; i++) nameBuf.writeUInt16BE(name.charCodeAt(i), i * 2);
    const body = Buffer.alloc(2 + nameBuf.length + 4 + 12 + 2);
    let p = 0;
    body.writeUInt16BE(name.length + 1, p); p += 2;
    nameBuf.copy(body, p); p += nameBuf.length;
    body.write('RGB ', p, 'ascii'); p += 4;
    rgb.forEach((v) => { body.writeFloatBE(v / 255, p); p += 4; });
    body.writeUInt16BE(2, p);
    const head = Buffer.alloc(6); head.writeUInt16BE(1, 0); head.writeUInt32BE(body.length, 2);
    return Buffer.concat([head, body]);
  });
  const h = Buffer.alloc(12); h.write('ASEF', 0, 'ascii'); h.writeUInt16BE(1, 4); h.writeUInt16BE(0, 6); h.writeUInt32BE(blocks.length, 8);
  return Buffer.concat([h, ...blocks]);
}

test('reads Adobe Swatch Exchange files', () => {
  const lib = inks.parseLibrary('pms.ase', makeAse([['PMS 186 C', [200, 16, 46]], ['PMS 286 C', [0, 51, 160]]]));
  assert.deepStrictEqual(lib.map((i) => [i.name, i.hex]), [['PMS 186 C', '#c8102e'], ['PMS 286 C', '#0033a0']]);
});

test('reads CSV with hex, RGB and Lab columns', () => {
  const lib = inks.parseLibrary('x.csv', 'Name,Color\nRed Ink,#ff0000\nBlue Ink,0,0,255\nGray Lab,50,0,0,lab\n');
  assert.strictEqual(lib.length, 3);
  assert.strictEqual(lib[1].hex, '#0000ff');
  assert.ok(Math.abs(lib[2].lab[0] - 50) < 1);
});

test('reads GIMP palettes', () => {
  const lib = inks.parseLibrary('x.gpl', 'GIMP Palette\nName: test\n#\n255 0 0 Red\n0 255 0 Green\n');
  assert.deepStrictEqual(lib.map((i) => i.name), ['Red', 'Green']);
});

test('reads Photoshop .aco swatches (v1 + v2)', () => {
  const words = (arr) => { const b = Buffer.alloc(arr.length * 2); arr.forEach((v, i) => b.writeUInt16BE(v, i * 2)); return b; };
  const v1 = words([1, 1, 0, 65535, 0, 0, 0]);
  const name = 'Hot Red';
  const v2 = Buffer.concat([words([2, 1, 0, 65535, 0, 0, 0, 0, name.length + 1]), words([...name].map((c) => c.charCodeAt(0)).concat([0]))]);
  const lib = inks.parseLibrary('x.aco', Buffer.concat([v1, v2]));
  assert.deepStrictEqual(lib.map((i) => [i.name, i.hex]), [['Hot Red', '#ff0000']]);
});

test('nearest ink uses CIEDE2000 and honours exclusions', () => {
  const lab = inks.BUILT_IN.find((i) => i.name === 'Royal Blue').lab;
  assert.strictEqual(inks.nearestInk(lab, inks.BUILT_IN).ink.name, 'Royal Blue');
  assert.notStrictEqual(inks.nearestInk(lab, inks.BUILT_IN, new Set(['Royal Blue'])).ink.name, 'Royal Blue');
});
