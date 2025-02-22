require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const { processRaydiumLpTransaction, connectToDatabase } = require('./newRaydiumLpService');
const SniperManager = require('./SniperManager');

const HELIUS_WS_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const connection = new Connection(HELIUS_WS_URL, 'confirmed');
const RAYDIUM_AMM_PROGRAM_ID = new PublicKey(process.env.RAYDIUM_AMM_PROGRAM_ID);
const JUPITER_AMM_ADDRESS = "JUP6bkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

async function subscribeRaydium() {
    console.log("Listening for new Raydium LP transactions via Helius...");
    connection.onLogs(RAYDIUM_AMM_PROGRAM_ID, async (log) => {
        try {
            if (log.logs.some(line => line.includes('InitializeInstruction2') || line.includes('CreatePool'))) {
                const signature = log.signature;

                const transactionDetails = await connection.getTransaction(signature, {
                    commitment: "confirmed",
                    maxSupportedTransactionVersion: 0,
                });

                if (transactionDetails) {
                    const message = transactionDetails.transaction.message;
                    const accounts = message.staticAccountKeys
                        ? message.staticAccountKeys.map((key) => key.toString())
                        : message.accountKeys.map((key) => key.toString());

                    if (accounts.includes(JUPITER_AMM_ADDRESS)) {
                        console.log("Transaction involves Jupiter AMM, skipping.");
                        return;
                    }
                }

                console.log("New AMM LP transaction found!");
                const tokenData = await processRaydiumLpTransaction(connection, signature);

                if (tokenData && tokenData._id) {
                    console.log(`Detected new pool with MongoDB ID: ${tokenData._id.toString()}`);

                    const sniperConfig = {
                        tokenId: tokenData._id.toString(), // Pass MongoDB ID
                        baseToken: process.env.BASE_TOKEN,
                        targetToken: tokenData.tokenAddress,
                        buyAmount: parseFloat(process.env.BUY_AMOUNT) || 1,
                        sellTargetPrice: parseFloat(process.env.SELL_TARGET_PRICE) || 2,
                        tokenData: tokenData
                    };

                    console.log(`Launching sniper for ${sniperConfig.targetToken} with ${sniperConfig.buyAmount} SOL`);
                    SniperManager.addSniper(sniperConfig);
                }
            }
        } catch (error) {
            console.error("Helius WS error:", error.message);
        }
    }, 'confirmed');
}

(async () => {
    await connectToDatabase();
    subscribeRaydium();
})();