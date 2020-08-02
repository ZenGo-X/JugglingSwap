import { ec as EC } from 'elliptic';
const ec = new EC('secp256k1');

export function toCompressed(uncompressed: Buffer) {
    return Buffer.from(ec.keyFromPublic(uncompressed.toString('hex'), 'hex').getPublic().encodeCompressed());
}