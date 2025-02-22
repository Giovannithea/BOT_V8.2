const { Connection, PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram, Keypair, SystemProgram } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createCloseAccountInstruction } = require("@solana/spl-token");
const { MongoClient, ObjectId } = require("mongodb");
const bs58 = require('bs58');
require("dotenv").config();

const connection = new Connection(process.env.SOLANA_WS_URL, "confirmed");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const RAYDIUM_AMM_PROGRAM_ID = new PublicKey(process.env.RAYDIUM_AMM_PROGRAM_ID);
let db;

// Updated for Raydium V4
function deriveAddresses(marketId) {
    const seeds = {
        ammAuthority: Buffer.from("amm_authority"),
        ammId: [
            Buffer.from("amm"),
            new PublicKey(marketId).toBuffer(),
            RAYDIUM_AMM_PROGRAM_ID.toBuffer()
        ],
        coinVault: [
            Buffer.from("coin_vault"),
            new PublicKey(marketId).toBuffer(),
            RAYDIUM_AMM_PROGRAM_ID.toBuffer()
        ],
        pcVault: [
            Buffer.from("pc_vault"),
            new PublicKey(marketId).toBuffer(),
            RAYDIUM_AMM_PROGRAM_ID.toBuffer()
        ]
    };

    return {
        ammAuthority: PublicKey.findProgramAddressSync([seeds.ammAuthority], RAYDIUM_AMM_PROGRAM_ID)[0],
        ammId: PublicKey.findProgramAddressSync(seeds.ammId, RAYDIUM_AMM_PROGRAM_ID)[0],
        coinVault: PublicKey.findProgramAddressSync(seeds.coinVault, RAYDIUM_AMM_PROGRAM_ID)[0],
        pcVault: PublicKey.findProgramAddressSync(seeds.pcVault, RAYDIUM_AMM_PROGRAM_ID)[0]
    };
}

async function fetchTokenDataFromMongo(tokenId) {
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const db = client.db("bot");

    const document = await db.collection("raydium_lp_transactionsV2").findOne({
        _id: new ObjectId(tokenId)
    });

    if (!document) throw new Error(`Token data not found for ID: ${tokenId}`);
    console.log("Fetched Token Data:", document); // Debug log
    return document;
}

async function createSwapInstruction({
                                         tokenId,
                                         userOwnerPublicKey,
                                         userSource,
                                         userDestination,
                                         amountSpecified,
                                         swapBaseIn
                                     }) {
    try {
        const tokenData = await fetchTokenDataFromMongo(tokenId);

        // Validate critical fields
        if (!tokenData?.marketId || !tokenData.ammOpenOrders) {
            throw new Error("Invalid token data from MongoDB");
        }

        const { ammAuthority, ammId, coinVault, pcVault } = deriveAddresses(tokenData.marketId);

        // Debug log derived addresses
        console.log("Derived Addresses:", {
            ammId: ammId.toString(),
            ammAuthority: ammAuthority.toString(),
            coinVault: coinVault.toString(),
            pcVault: pcVault.toString()
        });

        const keys = [
            { pubkey: ammId, isSigner: false, isWritable: true },
            { pubkey: ammAuthority, isSigner: false, isWritable: false },
            { pubkey: new PublicKey(tokenData.ammOpenOrders), isSigner: false, isWritable: true },
            { pubkey: coinVault, isSigner: false, isWritable: true },
            { pubkey: pcVault, isSigner: false, isWritable: true },
            { pubkey: new PublicKey(tokenData.marketProgramId), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(tokenData.marketId), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(tokenData.marketBids), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(tokenData.marketAsks), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(tokenData.marketEventQueue), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(tokenData.marketBaseVault), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(tokenData.marketQuoteVault), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(tokenData.marketAuthority), isSigner: false, isWritable: false },
            { pubkey: new PublicKey(userSource), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(userDestination), isSigner: false, isWritable: true },
            { pubkey: userOwnerPublicKey, isSigner: true, isWritable: false },
        ];

        const data = Buffer.alloc(9);
        data.writeUInt8(swapBaseIn ? 9 : 10, 0);
        data.writeBigUInt64LE(BigInt(amountSpecified), 1);

        return new TransactionInstruction({
            programId: RAYDIUM_AMM_PROGRAM_ID,
            keys,
            data
        });
    } catch (error) {
        console.error("createSwapInstruction failed:", error.message);
        throw error;
    }
}

async function swapTokens({
                              tokenId,
                              amountSpecified,
                              swapBaseIn
                          }) {
    const userOwner = Keypair.fromSecretKey(
        bs58.default.decode(process.env.WALLET_PRIVATE_KEY)
    );
    const userOwnerPublicKey = userOwner.publicKey;
    const tokenData = await fetchTokenDataFromMongo(tokenId);

    const isWSOL = tokenData.tokenAddress === WSOL_MINT.toString();
    let tempWSOLAccount, wrapIx, closeIx;
    const preInstructions = [];
    const postInstructions = [];

    if (isWSOL) {
        tempWSOLAccount = getAssociatedTokenAddressSync(
            WSOL_MINT,
            userOwnerPublicKey,
            true
        );

        const rentExempt = await connection.getMinimumBalanceForRentExemption(165);
        const totalLamports = amountSpecified + rentExempt;

        wrapIx = SystemProgram.transfer({
            fromPubkey: userOwnerPublicKey,
            toPubkey: tempWSOLAccount,
            lamports: totalLamports
        });

        preInstructions.push(
            wrapIx,
            createAssociatedTokenAccountInstruction(
                userOwnerPublicKey,
                tempWSOLAccount,
                userOwnerPublicKey,
                WSOL_MINT
            )
        );

        closeIx = createCloseAccountInstruction(
            tempWSOLAccount,
            userOwnerPublicKey,
            userOwnerPublicKey
        );
        postInstructions.push(closeIx);
    }

    const userSource = isWSOL ? tempWSOLAccount.toString() : getAssociatedTokenAddressSync(
        new PublicKey(tokenData.tokenAddress),
        userOwnerPublicKey
    ).toString();

    const userDestination = getAssociatedTokenAddressSync(
        new PublicKey(tokenData.tokenAddress),
        userOwnerPublicKey
    ).toString();

    const swapIx = await createSwapInstruction({
        tokenId,
        userOwnerPublicKey,
        userSource,
        userDestination,
        amountSpecified,
        swapBaseIn
    });

    const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }))
        .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }))
        .add(...preInstructions)
        .add(swapIx)
        .add(...postInstructions);

    tx.feePayer = userOwnerPublicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    // Validate transaction
    if (tx.instructions.length < 2) {
        throw new Error("Invalid transaction - missing instructions");
    }

    try {
        const sig = await connection.sendTransaction(tx, [userOwner]);
        await connection.confirmTransaction(sig);
        return sig;
    } catch (error) {
        console.error('Swap failed:', {
            logs: error.logs,
            message: error.message
        });
        throw error;
    }
}

module.exports = { swapTokens };