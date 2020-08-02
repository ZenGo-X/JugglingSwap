import {Currency} from "../common";
import {Transaction} from "./transaction";

export interface BlockchainClient {

    init(): Promise<void>;

    close(): Promise<void>;

    getAddress(publicKey: Buffer): string;

    buildTransaction(fromPublicKey: Buffer, amount: string | 'all', toPublicKey: Buffer): Promise<Transaction>;

    getBalance(publicKey: Buffer): Promise<string>;

    sendSignedTransaction(txHex: string): Promise<string>;
}