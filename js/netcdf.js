// A small writer for NetCDF-3 classic files (CDF-1), the format every
// NetCDF reader understands (netCDF4, xarray, SciPy, Panoply, ParaView).
// No record dimension and no compression: the download zips the file.
//
//   writeNetCDF({
//     dims: [["lat", 180], ["lon", 360]],
//     attrs: { title: "...", rss: 2.5 },
//     vars: [{ name: "br", dims: ["lat", "lon"], type: "float", data: Float32Array, attrs: { units: "G" } }],
//   }) -> Uint8Array
//
// Numeric attributes are written as doubles, strings as text. Variable
// types: byte, char, short, int, float, double. Data are big-endian.

const TYPES = { byte: [1, 1], char: [2, 1], short: [3, 2], int: [4, 4], float: [5, 4], double: [6, 8] };
const enc = new TextEncoder();
const pad4 = (n) => (4 - (n % 4)) % 4;

function attrBytes(attrs = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") parts.push([k, "char", enc.encode(v)]);
    else parts.push([k, "double", Float64Array.from(Array.isArray(v) || ArrayBuffer.isView(v) ? v : [v])]);
  }
  return parts;
}

export function writeNetCDF({ dims, attrs = {}, vars }) {
  const dimIndex = new Map(dims.map(([n], i) => [n, i]));
  const dimLen = new Map(dims);
  const gatts = attrBytes(attrs);
  const vlist = vars.map((v) => {
    const n = v.dims.reduce((a, d) => a * dimLen.get(d), 1);
    if (v.data.length !== n) throw new Error(`${v.name}: ${v.data.length} values for ${n} cells`);
    const [, size] = TYPES[v.type];
    return { ...v, n, vsize: n * size + pad4(n * size), atts: attrBytes(v.attrs) };
  });

  // Header size: everything but the data, offsets included.
  const nameLen = (s) => 4 + enc.encode(s).length + pad4(enc.encode(s).length);
  const attLen = (atts) => 8 + atts.reduce((a, [k, t, d]) => {
    const b = d.length * TYPES[t][1];
    return a + nameLen(k) + 8 + b + pad4(b);
  }, 0);
  let head = 4 + 4 + 8 + dims.reduce((a, [n]) => a + nameLen(n) + 4, 0) + attLen(gatts) + 8;
  for (const v of vlist) head += nameLen(v.name) + 4 + 4 * v.dims.length + attLen(v.atts) + 4 + 4 + 4;
  let off = head;
  for (const v of vlist) { v.begin = off; off += v.vsize; }
  if (off > 2 ** 31 - 1) throw new Error("file too large for CDF-1");

  const buf = new ArrayBuffer(off), dv = new DataView(buf), u8 = new Uint8Array(buf);
  let p = 0;
  const int = (x) => { dv.setInt32(p, x); p += 4; };
  const name = (s) => { const b = enc.encode(s); int(b.length); u8.set(b, p); p += b.length + pad4(b.length); };
  const write = (t, d) => {
    for (let i = 0; i < d.length; i++) {
      const x = d[i];
      if (t === "byte" || t === "char") dv.setInt8(p + i, x);
      else if (t === "short") dv.setInt16(p + 2 * i, x);
      else if (t === "int") dv.setInt32(p + 4 * i, x);
      else if (t === "float") dv.setFloat32(p + 4 * i, x);
      else dv.setFloat64(p + 8 * i, x);
    }
    const b = d.length * TYPES[t][1];
    p += b + pad4(b);
  };
  const atts = (list) => {
    if (!list.length) { int(0); int(0); return; }
    int(0x0c); int(list.length);
    for (const [k, t, d] of list) { name(k); int(TYPES[t][0]); int(d.length); write(t, d); }
  };

  u8.set([0x43, 0x44, 0x46, 1], 0); p = 4;   // "CDF" version 1
  int(0);                                      // no records
  if (dims.length) { int(0x0a); int(dims.length); for (const [n, len] of dims) { name(n); int(len); } } else { int(0); int(0); }
  atts(gatts);
  int(0x0b); int(vlist.length);
  for (const v of vlist) {
    name(v.name); int(v.dims.length);
    for (const d of v.dims) int(dimIndex.get(d));
    atts(v.atts); int(TYPES[v.type][0]); int(v.vsize); int(v.begin);
  }
  if (p !== head) throw new Error(`header size ${p} != ${head}`);
  for (const v of vlist) { p = v.begin; write(v.type, v.data); }
  return u8;
}
