import {Transaction, INVALID_SIGNATURE_ERROR} from "../transaction";
import * as bitcoin from "bitcoinjs-lib";
import {Input} from "bitcoinjs-lib/types/transaction";
import {EcdsaSignature} from "../signature";
import {toCompressed} from "../../crypto";

export class BitcoinTransaction implements Transaction {

    constructor(private transaction: bitcoin.Transaction) {}

    getHash(): Buffer {
        return this.transaction.getHash();
    }

    getHashesForSignatures(signingPublicKeys: Buffer[]): Buffer[] {
        return this.transaction.ins.map((input: Input, i: number) => {
            const childPublicKey = signingPublicKeys[i];
            const prevOutScript = bitcoin.payments.p2pkh({ pubkey: childPublicKey }).output as Buffer;
            return this.transaction.hashForSignature(i, prevOutScript, bitcoin.Transaction.SIGHASH_ALL);
        });
    }

    isDestinationPublicKey(publicKey: Buffer): boolean {
        const destinationPublicKeyHash = this.transaction.outs[0].script;
        const publicKeyHash = bitcoin.crypto.hash160(publicKey);
        return publicKeyHash.equals(destinationPublicKeyHash);
    }

    toBuffer(): Buffer {
        return this.transaction.toBuffer();
    }

    injectSignatures(signingPublicKeys: Buffer[], signatures: EcdsaSignature[]): void {
        const txBuilder = bitcoin.TransactionBuilder.fromTransaction(this.transaction, bitcoin.networks.testnet);
        signatures.forEach((sig: EcdsaSignature, i: number) => {
            const sigBuffer = Buffer.from(`${sig.r.padStart(64, '0')}${sig.s.padStart(64, '0')}`, 'hex');
            const publicKey = signingPublicKeys[i];
            const keyPair = bitcoin.ECPair.fromPublicKey(publicKey, { compressed: true, network: bitcoin.networks.testnet });
            txBuilder.sign({
                vin: i,
                prevOutScriptType: 'p2pkh',
                keyPair: {
                    publicKey: signingPublicKeys[i],
                    network: bitcoin.networks.testnet,
                    sign: (hash: Buffer): Buffer => {
                        if (!keyPair.verify(hash, sigBuffer)) {
                            throw new Error(INVALID_SIGNATURE_ERROR);
                        }

                        return sigBuffer;
                    }
                }
            });
        });

        this.transaction = txBuilder.build();
    }

    static fromBuffer(buffer: Buffer) {
        return new BitcoinTransaction(bitcoin.Transaction.fromBuffer(buffer));
    }
}