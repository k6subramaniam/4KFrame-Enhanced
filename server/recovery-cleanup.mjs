import fs from 'node:fs';
import path from 'node:path';

const catalogPath = '/data/frame.json';
const photosDir = '/data/photos';
const targetIds = [
  '1783644906474907','1783644907541400','1783644908331050','1783644909287416',
  '1783644910226336','1783644910836395','1783644911651294','1783644912585014',
  '1783644913398303','1783644914805507','1783644916710354','1783644917724371',
  '1783644919103489','1783644920008509','1783644920839121','1783644921772294',
  '1783644922666161','1783644924231443','1783644925132333','1783644926192364',
  '1783644927070133','1783644929025608','1783644929966232','1783644930685238',
  '1783644931508827','1783644933055287','1783644934561570','1783644935531304',
  '1783644936395609','1783644937503826'
];
const targetSet = new Set(targetIds);

function readCatalog() {
  return JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
}

const data = readCatalog();
if (!Array.isArray(data.items)) throw new Error('RECOVERY_ABORT missing items array');

const before = data.items.length;
const present = targetIds.filter(id => data.items.some(item => String(item.id) === id));

if (present.length !== 0 && present.length !== 30) {
  throw new Error(`RECOVERY_ABORT partial target presence ${present.length}/30`);
}

let deletedFiles = 0;
let deletedBytes = 0;

function unlinkIfFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return;
    fs.unlinkSync(filePath);
    deletedFiles++;
    deletedBytes += st.size;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

if (present.length === 30) {
  const oldest30 = [...data.items]
    .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0))
    .slice(0, 30)
    .map(item => String(item.id));

  if (oldest30.length !== 30 || oldest30.some((id, i) => id !== targetIds[i])) {
    throw new Error('RECOVERY_ABORT target IDs are no longer the exact oldest 30');
  }

  const byId = new Map(data.items.map(item => [String(item.id), item]));
  const explicitFields = ['file','preview','thumb','poster','upscaleSourceFile'];
  const filenames = new Set();

  for (const id of targetIds) {
    const item = byId.get(id);
    for (const field of explicitFields) {
      const value = item?.[field];
      if (typeof value === 'string' && value && !value.includes('/') && !value.includes('\\')) {
        filenames.add(value);
      }
    }
  }

  if (fs.existsSync(photosDir)) {
    for (const name of fs.readdirSync(photosDir)) {
      if (targetIds.some(id => name.includes(id))) filenames.add(name);
    }
  }

  for (const name of filenames) unlinkIfFile(path.join(photosDir, name));

  const newItems = data.items.filter(item => !targetSet.has(String(item.id)));
  if (newItems.length !== before - 30) {
    throw new Error(`RECOVERY_ABORT expected ${before - 30} items, got ${newItems.length}`);
  }
  data.items = newItems;

  const tmpPath = '/data/.frame.recovery.tmp';
  try { fs.unlinkSync(tmpPath); } catch (err) { if (err?.code !== 'ENOENT') throw err; }

  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, catalogPath);
}

try {
  const st = fs.statSync('/data/.frame.1.tmp');
  if (st.isFile() && st.size === 0) fs.unlinkSync('/data/.frame.1.tmp');
} catch (err) {
  if (err?.code !== 'ENOENT') throw err;
}

const verify = readCatalog();
const remainingIds = new Set(verify.items.map(item => String(item.id)));
const stillPresent = targetIds.filter(id => remainingIds.has(id));
if (stillPresent.length) throw new Error(`RECOVERY_VERIFY_FAIL ${stillPresent.length} target IDs remain`);

const leftovers = fs.existsSync(photosDir)
  ? fs.readdirSync(photosDir).filter(name => targetIds.some(id => name.includes(id)))
  : [];
if (leftovers.length) throw new Error(`RECOVERY_VERIFY_FAIL ${leftovers.length} target asset filenames remain`);

const stat = fs.statfsSync('/data');
const freeBytes = Number(stat.bavail) * Number(stat.bsize);
const firstIso = new Date(1783644906819).toISOString();
const lastIso = new Date(1783644937690).toISOString();

console.log(
  `RECOVERY_DELETE_OK before=${before} after=${verify.items.length} deletedItems=${present.length || 30} files=${deletedFiles} bytes=${deletedBytes} freeBytes=${freeBytes} range=${firstIso}..${lastIso}`
);
