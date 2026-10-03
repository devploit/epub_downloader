const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// EPUB requires mimetype first, stored without compression or extra fields.
// STORE for every entry keeps the packager small and preserves original bytes.
export function createEpub(entries) {
  if (entries.keys().next().value !== "mimetype" || new TextDecoder().decode(entries.get("mimetype")) !== "application/epub+zip") {
    throw new Error("The first EPUB entry must be its mimetype.");
  }
  if (entries.size > 65535) throw new Error("ZIP64 is not supported.");
  const parts = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const [path, bytes] of entries) {
    const name = encoder.encode(path);
    if (name.length > 65535 || offset + bytes.length > 0xffffffff) throw new Error("ZIP size limit exceeded.");
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + name.length);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true);
    header.setUint16(12, 33, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, bytes.length, true);
    header.setUint32(22, bytes.length, true);
    header.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, bytes);
    const central = new Uint8Array(46 + name.length);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(14, 33, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, bytes.length, true);
    record.setUint32(24, bytes.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.set(name, 46);
    directory.push(central);
    directorySize += central.length;
    offset += local.length + bytes.length;
  }
  const end = new Uint8Array(22);
  const footer = new DataView(end.buffer);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, entries.size, true);
  footer.setUint16(10, entries.size, true);
  footer.setUint32(12, directorySize, true);
  footer.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: "application/epub+zip" });
}
