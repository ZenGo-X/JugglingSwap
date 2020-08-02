import assert from 'assert';
import axios from 'axios';
import path from "path";
import {
    CoinDerivationIndex,
    MatchParams, notEnoughFunds,
    Order,
    REST_SERVER_URL,
} from "./common";
import User from "./user";
import {gr} from 'dlog-verifiable-enc';
import {ec as EC} from 'elliptic';
import {toCompressed} from "./crypto";
const ec = new EC('secp256k1');
const debug = require('debug')('maker');

export default class Maker extends User {

    private static DB_PATH = path.join(__dirname, '../../maker-db');

    constructor() {
        super();
    }

    public async makeOrder(order: Order) {
        const { sourceCurrency, destinationCurrency, sourceAmount, destinationAmount } = order;
        if (!await this.hasSufficientBalanceFor(sourceCurrency, sourceAmount)) {
            throw new Error(notEnoughFunds);
        }

        const depositAccountIndex = this.getAndIncrementAccountIndex(sourceCurrency);

        const encryptionKeyPair = ec.genKeyPair();
        const encryptionKey = encryptionKeyPair.getPublic().encode('hex', false);

        const depositTx = await this.buildAndSignTransaction(sourceCurrency, sourceAmount, depositAccountIndex);
        const depositTxHex = depositTx.toBuffer().toString('hex');

        let data;
        debug('Calling /order');
        try {
            const response = await axios.post(
                `${REST_SERVER_URL}/order`,
                {
                    masterKeyId: this.getMasterKeyId(),
                    depositAccountIndex,
                    depositTxHex,
                    encryptionKey,
                    sourceCurrency,
                    sourceAmount,
                    destinationCurrency,
                    destinationAmount,
                });
            data = response.data;
        } catch (err) {
            return console.error(err.response.data);
        }

        const { orderId } = data;

        // write to DB
        this.db
            .get('orders')
            .push({
                id: orderId,
                sourceCurrency,
                sourceAmount,
                destinationCurrency,
                destinationAmount,
                depositAccountIndex,
                encryptionKeyPair: {
                    private: encryptionKeyPair.getPrivate('hex'),
                    public: encryptionKey
                }
            })
            .write();
    }

    protected getDbPath(): string {
        return Maker.DB_PATH;
    }

    protected on(msg: any): void {
        if (msg.type === 'match') {
            this.onMatch(msg);
        } else {
            super.on(msg);
        }
    }

    private onMatch(params: MatchParams): void {
        debug("on('match')");

        // check that all keys are in uncompressed format
        assert(params.counterpartyDepositPublicKey.length === 130);
        assert(params.counterpartyEncryptionKey.length === 130);

        // check that the transaction's destination address matches the counterparty's public key
        const { sourceCurrency, depositAccountIndex, destinationCurrency } = this.db.get('orders').find({ id: params.orderId }).value();
        const counterpartyDepositTxBuffer = Buffer.from(params.counterpartyDepositTxHex, 'hex');
        const counterpartyDepositTx = this.getBlockchainManager().transactionFromBuffer(destinationCurrency, counterpartyDepositTxBuffer);
        assert(
            counterpartyDepositTx.isDestinationPublicKey(toCompressed(Buffer.from(params.counterpartyDepositPublicKey, 'hex'))),
            'deposit transaction destination does not match counterparty deposit public key'
        );

        const counterpartyEncryptionKeyBuffer = Buffer.from(params.counterpartyEncryptionKey.substr(2), 'hex');  // strip the '04' prefix

        // get this party's deposit public key
        const depositPrivateShare = this.getParty2().getChildShare(this.getParty2Share(), CoinDerivationIndex[sourceCurrency], depositAccountIndex);
        const depositPrivateKeyBuffer = Buffer.from((depositPrivateShare as any).master_key.private.x2.padStart(64, '0'), 'hex');
        assert(depositPrivateKeyBuffer.length === 32);

        // get the gradual release first message and share
        const [gradualReleaseFirstMessage, gradualReleaseShare] = gr.createShare(
            depositPrivateKeyBuffer,
            counterpartyEncryptionKeyBuffer
        );

        // store all information needed for the following verifiable encrypted segment events
        this.db
            .get('orders')
            .find({ id: params.orderId })
            .assign({
                gradualReleaseShare,
                pendingIndex: -1,  // waiting for first message
                counterpartyEncryptionKey: params.counterpartyEncryptionKey,
                counterpartyDepositPublicKey: params.counterpartyDepositPublicKey,
            })
            .write();

        axios.post(
            `${REST_SERVER_URL}/gradualReleaseFirstMessage`,
            {
                side: 'maker',
                masterKeyId: this.getMasterKeyId(),
                orderId: params.orderId,
                gradualReleaseFirstMessage,
            });
    }

    protected onGradualReleaseFirstMessage(msg: any) {
        const {
            orderId,
            gradualReleaseFirstMessage: counterpartyGradualReleaseFirstMessage,
        } = msg;

        const order = this.db
            .get('orders')
            .find({ id: orderId, pendingIndex: -1 })
            .value();
        if (!order) {
            return console.warn('Order not found');
        }

        const { encryptionKeyPair, gradualReleaseShare } = order;
        const encryptionKeyBuffer = Buffer.from(
            encryptionKeyPair.public.substr(2),  // (x,y) without '04' uncompressed prefix
            'hex'
        );
        if (!gr.verifyStart(counterpartyGradualReleaseFirstMessage, encryptionKeyBuffer)) {
            return console.warn('Gradual release first message failed verification')
        }

        this.db
            .get('orders')
            .find({ id: orderId })
            .assign({
                pendingIndex: 0,
                gradualReleaseShare,
                counterpartyGradualReleaseFirstMessage
            })
            .write();

        debug('Gradual release first message verification passed!');
        // encrypt and prove for segment #0
        const segmentProof = gr.Share.fromPlain(gradualReleaseShare)
            .proveSegment(0);

        axios.post(
            `${REST_SERVER_URL}/segment`,
            {
                side: 'maker',
                masterKeyId: this.getMasterKeyId(),
                orderId,
                segmentProof
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

        const { counterpartyGradualReleaseFirstMessage, encryptionKeyPair, gradualReleaseShare, destinationCurrency } = order;
        // verify segment
        const encryptionKeyBuffer = Buffer.from(encryptionKeyPair.public.substr(2), 'hex');
        if (!gr.verifySegment(counterpartyGradualReleaseFirstMessage, counterpartySegmentProof, encryptionKeyBuffer)) {
            return console.warn(`Segment ${counterpartySegmentProof.k} validation failed`);
        }

        // add given segment proof to the array of segment proofs so far
        const segmentProofs = order.segmentProofs || [];
        segmentProofs.push(counterpartySegmentProof);
        // TODO: use constant for number of segments
        if (segmentProofs.length === 32) {
            const decryptionKey = Buffer.from(encryptionKeyPair.private, 'hex');
            const counterpartyDepositPrivateKey = gr.extractSecret(
                counterpartyGradualReleaseFirstMessage,
                segmentProofs,
                decryptionKey
            );
            debug('Extracted counterparty deposit private key.');
            this.withdraw(orderId, destinationCurrency, counterpartyDepositPrivateKey, 'maker');
            return;
        }

        this.db
            .get('orders')
            .find({ id: orderId })
            .assign({ segmentProofs, pendingIndex: counterpartySegmentProof.k + 1 })
            .write();

        const segmentProof = gr.Share.fromPlain(gradualReleaseShare)
            .proveSegment(counterpartySegmentProof.k + 1);

        axios.post(
            `${REST_SERVER_URL}/segment`,
            {
                side: 'maker',
                masterKeyId: this.getMasterKeyId(),
                orderId,
                segmentProof,
            });
    }
}