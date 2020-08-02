import {EcdsaSignature} from "./signature";

export const INVALID_SIGNATURE_ERROR = "Invalid signature";

export interface Transaction {

    getHash(): Buffer;

    /**
     * @param signingPublicKeys given as compressed ('03' or '02' prefixed) secp256k1 public keys
     */
    getHashesForSignatures(signingPublicKeys: Buffer[]): Buffer[];

    /**
     * @param publicKey given as an uncompressed ('03' or '02' prefixed) secp256k1 public key
     */
    isDestinationPublicKey(publicKey: Buffer): boolean;

    toBuffer(): Buffer;

    injectSignatures(signingPublicKeys: Buffer[], signatures: EcdsaSignature[]): void;
}