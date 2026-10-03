import { cronJobs } from "convex/server";
import { api } from "./_generated/api";

const crons = cronJobs();

// §5: consolidation-era jobs — sweeper every 5 min, pattern scan every 15 min
crons.interval("outcome sweeper", { minutes: 5 }, api.ingest.sweepOutcomes, {});
crons.interval("pattern scan", { minutes: 15 }, api.ingest.runPatternScan, {});

export default crons;
