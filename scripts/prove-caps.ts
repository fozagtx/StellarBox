import { runCapsProof } from "../packages/stellar/src/proof.js";

const summary = await runCapsProof();
console.log(JSON.stringify(summary, null, 2));
if (summary.fatalError || summary.steps.some((step) => !step.passed)) {
  process.exitCode = 1;
}
