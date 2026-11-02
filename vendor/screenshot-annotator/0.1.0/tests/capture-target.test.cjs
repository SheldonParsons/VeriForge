const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {captureTarget, writePair} = require('../scripts/capture-target.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-test-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const png = Buffer.alloc(24); png.writeUInt32BE(800,16); png.writeUInt32BE(600,20);
  const state = {width:800,height:600,scrollX:0,scrollY:240,zoom:1};
  const page = {evaluate:async()=>state,screenshot:async options=>{assert.equal(options.scale,'css');return png;}};
  const locator = {count:async()=>1,waitFor:async()=>{},scrollIntoViewIfNeeded:async()=>{},boundingBox:async()=>({x:80,y:120,width:100,height:40})};
  return {dir,page,locator,raw:path.join(dir,'raw.png'),json:path.join(dir,'spec.json')};
}
test('captures CSS viewport coordinates', async t=>{
  const f=await fixture(t); const spec=await captureTarget(f.page,f.locator,f.raw,f.json,'Check');
  assert.equal(spec.schema_version,1); assert.equal(spec.annotations[0].box.y,120);
  assert.deepEqual(JSON.parse(await fs.readFile(f.json,'utf8')),spec);
});
test('refuses duplicate locator',async t=>{
  const f=await fixture(t); f.locator.count=async()=>2;
  await assert.rejects(captureTarget(f.page,f.locator,f.raw,f.json,'Check'),/exactly one/);
  assert.deepEqual(await fs.readdir(f.dir),[]);
});
test('movement stops after three captures',async t=>{
  const f=await fixture(t); let n=0; f.locator.boundingBox=async()=>({x:80,y:++n,width:100,height:40});
  await assert.rejects(captureTarget(f.page,f.locator,f.raw,f.json,'Check'),/moved/);
  assert.equal(n,6); assert.deepEqual(await fs.readdir(f.dir),[]);
});
test('rejects screenshot dimension mismatch',async t=>{
  const f=await fixture(t); f.page.evaluate=async()=>({width:400,height:300,scrollX:0,scrollY:0,zoom:1});
  await assert.rejects(captureTarget(f.page,f.locator,f.raw,f.json,'Check'),/PNG size/);
});
test('second output failure rolls back only the new file',async t=>{
  const f=await fixture(t); await fs.writeFile(f.json,'keep');
  await assert.rejects(writePair([[f.raw,Buffer.from('new')],[f.json,Buffer.from('replace')]]));
  assert.equal(await fs.readFile(f.json,'utf8'),'keep');
  await assert.rejects(fs.access(f.raw));
});
test('refuses existing outputs',async t=>{
  const f=await fixture(t);await fs.writeFile(f.raw,'keep');
  await assert.rejects(captureTarget(f.page,f.locator,f.raw,f.json,'Check'),/overwrite/);
  assert.equal(await fs.readFile(f.raw,'utf8'),'keep');
});
