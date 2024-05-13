import { Database } from "bun:sqlite";
import { Client } from "nimiq-rpc-client-ts";

if (!Bun.env.RPC_URL) throw new Error("RPC_URL is not set");

const url = new URL(Bun.env.RPC_URL);
const client = new Client(url);
const db = new Database("mydb.sqlite");

interface ValidatorRow {
  id: number;
  address: string;
  batchNumber: number;
  slotsAssignedCount: number;
  penalizedCount: number;
}

const policies = await client.policy.getPolicyConstants();
const batchesPerEpoch = policies.data?.batchesPerEpoch || 360;
const getValidatorsData = db.query("SELECT * FROM validators");

interface ValidatorUptime {
  address: string;
  penalizedCount: number;
  slotsAssignedCount: number;
  batchNumber: number;
  epochNumber: number;
}
interface ValidatorsUptime {
  [address: string]: ValidatorUptime[];
}

const validatorsUptime: ValidatorsUptime = {};

console.log("Getting validators data...");
const validators = getValidatorsData.all() as ValidatorRow[];
console.log("Rows:", validators.length);

validators.forEach((validator) => {
  const { address } = validator;
  if (!validatorsUptime[address]) {
    validatorsUptime[address] = [];
  }
  validatorsUptime[address].push({
    ...validator,
    epochNumber: Math.floor(validator.batchNumber / batchesPerEpoch),
  });
});

console.log("Writing validators.json...");
const validatorsJSON = Bun.file("validators.json", {
  type: "application/json",
});
await Bun.write(validatorsJSON, JSON.stringify(validatorsUptime, null, 2));
console.log("Done.");
