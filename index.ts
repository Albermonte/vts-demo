import { Database } from "bun:sqlite";
import { BlockType, Client, InherentType } from "nimiq-rpc-client-ts";

if (!Bun.env.RPC_URL) throw new Error("RPC_URL is not set");

const url = new URL(Bun.env.RPC_URL);
const client = new Client(url);
const db = new Database("mydb.sqlite", { create: true });

const policies = await client.policy.getPolicyConstants();
const initialBlock = 8806739;
// const initialBlock = 0;
const blocksPerBatch = policies.data?.blocksPerBatch || 60;
const batchesPerEpoch = policies.data?.batchesPerEpoch || 360;

process.on("SIGINT", () => {
  console.log("\nCaught interrupt signal, closing DB");
  db.close();
  process.exit();
});

db.exec("PRAGMA journal_mode = WAL;");

db.query(`
    CREATE TABLE IF NOT EXISTS validators (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT,
        batchNumber INTEGER,
        rewarded BOOLEAN DEFAULT FALSE,
        penalized BOOLEAN DEFAULT FALSE,
        slotsAssignedCount INTEGER DEFAULT 0,
        penalizedCount INTEGER DEFAULT 0
    )
`).run();

// db.query(`
//     CREATE TABLE IF NOT EXISTS penalizedBlocks (
//       id INTEGER PRIMARY KEY AUTOINCREMENT,
//       validatorAddress TEXT,
//       blockNumber INTEGER,
//       FOREIGN KEY (validatorAddress) REFERENCES validators(address)
//   )
// `).run();

// Create key-value table
interface KeyValueRow {
  key: string;
  value: string;
}
db.query(
  "CREATE TABLE IF NOT EXISTS key_value (key TEXT PRIMARY KEY, value TEXT)",
).run();

const query = `SELECT value FROM key_value WHERE key = 'currentBatchNumber'`;
const result = db.query(query).get() as KeyValueRow | undefined;

let currentBatchNumber = result ? Number(result.value) : 0;
let latestBatchNumber = -1;

const updateLatestBatchNumber = async () => {
  const latestBlock = await client.blockchain.getLatestBlock();
  latestBatchNumber = latestBlock.data?.batch || latestBatchNumber;
  console.log("latestBatchNumber", latestBatchNumber);
};

const getInherents = async (batchNumber: number) => {
  const inherents = await client.blockchain.getInherentsByBatchNumber(
    batchNumber,
  );
  return inherents.data;
};

await updateLatestBatchNumber();

const insertValidatorBatch = db.prepare(
  "INSERT INTO validators (address, batchNumber, rewarded, penalized) VALUES ($address, $batchNumber, $rewarded, $penalized)",
);

const updateValidatorBatch = db.prepare(
  "UPDATE validators SET rewarded = $rewarded, penalized = $penalized WHERE address = $address AND batchNumber = $batchNumber",
);

const incrementSlotsAssignedCount = db.prepare(
  "UPDATE validators SET slotsAssignedCount = slotsAssignedCount +  $slotsAssignedCount WHERE address = $address AND batchNumber = $batchNumber",
);

const incrementPenalizedCount = db.prepare(
  "UPDATE validators SET penalizedCount = penalizedCount + 1 WHERE address = $address AND batchNumber = $batchNumber",
);

const updateLatestBatchNumberQuery = db.prepare(
  "INSERT OR REPLACE INTO key_value (key, value) VALUES ('currentBatchNumber', $currentBatchNumber)",
);

// const insertBlock = db.prepare(
//   "INSERT INTO penalizedBlocks (validatorAddress, blockNumber) VALUES (?, ?)",
// );

const updateSlotsAssigned = async (batchNumber: number) => {
  const blockNumber = initialBlock + batchNumber * blocksPerBatch;
  const block = await client.blockchain.getBlockByNumber(blockNumber, {
    includeTransactions: true,
  });
  if (block.data?.type === BlockType.Macro && block.data?.isElectionBlock) {
    const { slots } = block.data;
    slots.forEach((slot) => {
      for (let i = 0; i < batchesPerEpoch; i++) {
        insertValidatorBatch.run({
          $address: slot.validator,
          $batchNumber: batchNumber + i,
          $rewarded: false,
          $penalized: false,
        });
        incrementSlotsAssignedCount.run({
          $address: slot.validator,
          $batchNumber: batchNumber + i,
          $slotsAssignedCount: slot.numSlots,
        });
      }
    });
  }
};

console.log("Starting from batch number", currentBatchNumber);
// Batch 0 doesn't have any inherents
do {
  updateLatestBatchNumberQuery.run({
    $currentBatchNumber: currentBatchNumber,
  });

  if (currentBatchNumber % 100 === 0) {
    console.clear();
    console.log(`${currentBatchNumber}/${latestBatchNumber}`);
  }

  if (currentBatchNumber % batchesPerEpoch === 0) {
    console.log("Updating slots assigned...");
    await updateSlotsAssigned(currentBatchNumber);
  }

  const inherents = await getInherents(currentBatchNumber);
  if (!inherents) {
    if (latestBatchNumber <= currentBatchNumber) {
      await updateLatestBatchNumber();
    }
    currentBatchNumber++;
    continue;
  }

  inherents.forEach((inherent) => {
    if (inherent.type === InherentType.Reward) {
      updateValidatorBatch.run({
        $address: inherent.validatorAddress,
        $batchNumber: currentBatchNumber,
        $rewarded: true,
        $penalized: false,
      });
    }
  });

  inherents.forEach((inherent) => {
    if (
      inherent.type === InherentType.Penalize ||
      inherent.type === InherentType.Jail
    ) {
      updateValidatorBatch.run({
        $address: inherent.validatorAddress,
        $batchNumber: currentBatchNumber,
        $rewarded: false,
        $penalized: true,
      });
      incrementPenalizedCount.run({
        $address: inherent.validatorAddress,
        $batchNumber: currentBatchNumber,
      });
    }
  });

  if (latestBatchNumber <= currentBatchNumber) await updateLatestBatchNumber();
  currentBatchNumber++;
} while (latestBatchNumber > currentBatchNumber);

console.log("Done");
db.close();
