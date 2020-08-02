import {INVALID_SIGNATURE_ERROR, Transaction} from "../transaction";
import { Transaction as EthereumJsTransaction } from 'ethereumjs-tx';
import {EcdsaSignature} from "../signature";
import {toCompressed} from "../../crypto";
import {publicToAddress} from "ethereumjs-util";

export class EthereumTransaction implements Transaction {

    constructor(private transaction: EthereumJsTransaction) {}

    getHash(): Buffer {
        return this.transaction.hash();
    }

    getHashesForSignatures(signingPublicKeys: Buffer[]): Buffer[] {
        return [this.transaction.hash(false)];
    }

    injectSignatures(signingPublicKeys: Buffer[], signatures: EcdsaSignature[]): void {
        const sig = signatures[0];
        const r = `0x${sig.r.padStart(64, '0')}`;
        const s = `0x${sig.s.padStart(64, '0')}`;
        const v = `0x${(sig.recid + (this.transaction.getChainId() * 2 + 35)).toString(16)}`;
        const signedEthTx = new EthereumJsTransaction({
                ...this.transaction.toJSON(true),
                r,
                s,
                v,
            },
            {
                chain: 'ropsten'
            });
        if (!signedEthTx.validate()) {
            throw new Error(INVALID_SIGNATURE_ERROR);
        }

        this.transaction = signedEthTx;
    }

    isDestinationPublicKey(publicKey: Buffer): boolean {
        const destinationAddress = this.transaction.to;
        const addressToCheck = publicToAddress(publicKey, true);

        return addressToCheck.equals(destinationAddress);
    }

    toBuffer(): Buffer {
        return this.transaction.serialize();
    }

    static fromBuffer(buffer: Buffer) {
        return new EthereumTransaction(new EthereumJsTransaction(buffer, { chain: 'ropsten' }));
    }
}