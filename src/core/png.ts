import fs from 'node:fs';

/** Dimensions d'un PNG lues dans l'en-tête IHDR (octets 16–23) ; {} si le fichier n'est pas un PNG. */
export function pngSize(file: string): { w?: number; h?: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return {};
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}
