import { Database } from "bun:sqlite";
import { Client, PolicyConstants } from "nimiq-rpc-client-ts";

if (!Bun.env.RPC_URL) throw new Error("RPC_URL is not set");

const url = new URL(Bun.env.RPC_URL);
const client = new Client(url);
const db = new Database("mydb.sqlite");
const { data: policyConstants } = await client.policy.getPolicyConstants();
if (!policyConstants) throw new Error("Could not get policy constants");
const { blocksPerBatch } = policyConstants as PolicyConstants & { blockSeparationTime: number, genesisBlockNumber: number }
// TODO: time between blocks can be different than 1 minute

// Parameter determining how much the observation of the oldest batch is worth relative to the observation of the newest batch
const a = 0.5;
const batchesInADay = blocksPerBatch * 60 * 24;
// 9 months
const days = 9 * 30;
const n = batchesInADay * days;

interface ValidatorRow {
  id: number;
  address: string;
  batchNumber: number;
  slotsAssignedCount: number;
  penalizedCount: number;
}
interface ValidatorsReliability {
  [address: string]: ValidatorRow[];
}

const getBatch = db.prepare("SELECT * FROM validators WHERE batchNumber = ?");
// Get the highest batch number
const getBatchCount = db.prepare("SELECT MAX(batchNumber) as count FROM validators");

const calculateReliability = (validator: ValidatorRow[], n = 1) => {
  let sumNumerator = 0;
  for (let i = 0; i < n; i++) {
    if (!validator[i]) break;
    const { slotsAssignedCount, penalizedCount } = validator[i];
    const rewardedSlots = slotsAssignedCount - penalizedCount;
    const x = rewardedSlots / slotsAssignedCount;

    const denominator = (1 - a * i / (n - 1)) * x;
    sumNumerator += denominator;
  }

  let sumDenominator = 0;
  for (let i = 0; i < n; i++) {
    if (!validator[i]) break;
    const denominator = 1 - a * i / (n - 1);
    sumDenominator += denominator;
  }

  return sumNumerator / sumDenominator;
};

const validators = [];
const numberOfBatches = (getBatchCount.get() as {count: number}).count;

// TODO: get batches starting from last one
console.log(`Getting ${numberOfBatches} batches...`);

for (let i = 0; i < numberOfBatches; i++) {
  if (i % 1000 === 0) console.log(`${i}/${numberOfBatches}`);

  const validator = getBatch.all(i) as ValidatorRow[];
  // x_i is the observation at batch number i with i=0 representing the most recent batch
  validators.unshift(...validator);
}
console.log("Rows:", validators.length);

const validatorsReliability: ValidatorsReliability = {};
validators.forEach((validator) => {
  const { address } = validator;
  if (!validatorsReliability[address]) {
    validatorsReliability[address] = [];
  }
  validatorsReliability[address].push(validator);
});

const reliability = [];

console.log("Calculating reliability...");
for (const address in validatorsReliability) {
  const validator = validatorsReliability[address];
  const validatorReliability = calculateReliability(
    validator,
    Math.min(n, numberOfBatches),
  );
  reliability.push({ address, reliability: validatorReliability });
}

console.log("Reliability", reliability);

// Adjust to curve
const center = -0.16;
const toCurve = (x: number) => {
  return -center + 1 - Math.sqrt(-(x ** 2) + 2 * center * x + (center - 1) ** 2);
}

const adjustedReliability = reliability.map(({ address, reliability }) => {
  const adjustedReliability = toCurve(reliability)
  return { address, reliability: adjustedReliability };
});

console.log("Adjusted Reliability", adjustedReliability);
