import axios from 'axios';
import {CoinDerivationIndex, notEnoughFunds, Order, REST_SERVER_URL} from "./common";
import User from "./user";
import path from "path";
import {gr} from "dlog-verifiable-enc";
import assert from "assert";
import {ec as EC} from 'elliptic';
const ec = new EC('secp256k1');
const debug = require('debug')('taker');

export default class Taker extends User {

    private static DB_PATH = path.join(__dirname, '../../taker-db');

    constructor() {
       super();
    }

    public async getOrders(): Promise<({ id: string } & Order)> {
        return (await axios.get(`${REST_SERVER_URL}/orders`)).data;
    }

    public async takeOrder(orderId: string) {
        let data;
        try {
            const response = await axios.get(`${REST_SERVER_URL}/order/${orderId}`);
            data = response.data;
        } catch (err) {
            return console.error(err.response.data);
        }

        const { sourceCurrency, destinationCurrency, sourceAmount, destinationAmount } = data;
        if (!await this.hasSufficientBalanceFor(destinationCurrency, destinationAmount)) {
            throw new Error(notEnoughFunds);
        }

        const depositAccountIndex = this.getAndIncrementAccountIndex(destinationCurrency);

        const encryptionKeyPair = ec.genKeyPair();
        const encryptionKey = encryptionKeyPair.getPublic().encode('hex', false);

        const depositTx = await this.buildAndSignTransaction(destinationCurrency, destinationAmount, depositAccountIndex);
        const depositTxHex = depositTx.toBuffer().toString('hex');

        debug('Calling /takeOrder');
        try {
            const response = await axios.post(
                `${REST_SERVER_URL}/takeOrder`,
                {
                    masterKeyId: this.getMasterKeyId(),
                    orderId,
                    depositAccountIndex,
                    depositTxHex,
                    encryptionKey,
                });
            data = response.data;
        } catch (err) {
            return console.error(err.response.data);
        }

        const {
            counterpartyEncryptionKey,
            counterpartyDepositPublicKey,
        } = data;

        // save counterpartyEncryptionKey & counterpartyDepositPublicKey for the secret-exchange interactive protocol
        this.db
            .get('orders')
            .push({
                id: orderId,
                sourceCurrency,
                destinationCurrency,
                sourceAmount,
                destinationAmount,
                depositAccountIndex,
                encryptionKeyPair: {
                    private: encryptionKeyPair.getPrivate('hex'),
                    public: encryptionKey
                },
                counterpartyEncryptionKey,
                counterpartyDepositPublicKey,
            })
            .write();
    }

    protected getDbPath(): string {
        return Taker.DB_PATH;
    }

    protected onGradualReleaseFirstMessage(msg: any): void {
        const {
            orderId,
            gradualReleaseFirstMessage: counterpartyGradualReleaseFirstMessage,
        } = msg;

        const order = this.db
            .get('orders')
            .find({ id: orderId})
            .value();
        if (!order) {
            return console.warn('Order not found');
        }

        const { destinationCurrency, depositAccountIndex, encryptionKeyPair, counterpartyEncryptionKey } = order;
        const encryptionKeyBuffer = Buffer.from(
            encryptionKeyPair.public.substr(2),  // (x,y) without '04' uncompressed prefix
            'hex'
        );
        assert(encryptionKeyBuffer.length === 64);
        if (!gr.verifyStart(counterpartyGradualReleaseFirstMessage, encryptionKeyBuffer)) {
            return console.warn('Gradual release first message verification failed')
        }

        debug('Gradual release first message verification passed!');
        // send the maker our first gradual release message
        const counterpartyEncryptionKeyBuffer = Buffer.from(
            counterpartyEncryptionKey.substr(2),
            'hex'
        );
        assert(counterpartyEncryptionKeyBuffer.length === 64);

        const depositPrivateShare = this.getParty2().getChildShare(this.getParty2Share(), CoinDerivationIndex[destinationCurrency], depositAccountIndex);
        const depositPrivateKeyBuffer = Buffer.from((depositPrivateShare as any).master_key.private.x2.padStart(64, '0'), 'hex');
        assert(depositPrivateKeyBuffer.length === 32);

        const [gradualReleaseFirstMessage, gradualReleaseShare] = gr.createShare(
            depositPrivateKeyBuffer,
            counterpartyEncryptionKeyBuffer
        );

        this.db
            .get('orders')
            .find({ id: orderId })
            .assign({
                pendingIndex: 0,
                gradualReleaseShare,
                counterpartyGradualReleaseFirstMessage
            })
            .write();

        axios.post(
            `${REST_SERVER_URL}/gradualReleaseFirstMessage`,
            {
                side: 'taker',
                masterKeyId: this.getMasterKeyId(),
                orderId,
                gradualReleaseFirstMessage,
            });
    }

    protected onSegment(msg: any): void {
        const {
            orderId,
            segmentProof: counterpartySegmentProof
        } = msg;

        const order = this.db
            .get('orders')
            .find({ id: orderId, pendingIndex: counterpartySegmentProof.k })
            .value();
        if (!order) {
            return console.warn('Order not found');
        }

        const { counterpartyGradualReleaseFirstMessage, encryptionKeyPair, gradualReleaseShare, sourceCurrency } = order;
        // verify segment
        const encryptionKeyBuffer = Buffer.from(
            encryptionKeyPair.public.substr(2),
            'hex'
        );
        if (!gr.verifySegment(counterpartyGradualReleaseFirstMessage, counterpartySegmentProof, encryptionKeyBuffer)) {
            return console.warn(`Segment ${counterpartySegmentProof.k} validation failed`);
        }

        // add given segment proof to the array of segment proofs so far
        const segmentProofs = order.segmentProofs || [];
        segmentProofs.push(counterpartySegmentProof);

        this.db
            .get('orders')
            .find({ id: orderId })
            .assign({ segmentProofs, pendingIndex: counterpartySegmentProof.k + 1 })
            .write();

        const segmentProof = gr.Share.fromPlain(gradualReleaseShare)
            .proveSegment(counterpartySegmentProof.k);

        axios.post(
            `${REST_SERVER_URL}/segment`,
            {
                side: 'taker',
                masterKeyId: this.getMasterKeyId(),
                orderId,
                segmentProof,
            });

        // TODO: use constant for number of segments
        if (segmentProofs.length === 32) {
            const decryptionKey = Buffer.from(encryptionKeyPair.private, 'hex');
            assert(decryptionKey.length === 32);

            const counterpartyDepositPrivateKey = gr.extractSecret(
                counterpartyGradualReleaseFirstMessage,
                segmentProofs,
                decryptionKey
            );
            debug('Extracted counterparty deposit private key');
            this.withdraw(orderId, sourceCurrency, counterpartyDepositPrivateKey, 'taker');
        }
    }
}