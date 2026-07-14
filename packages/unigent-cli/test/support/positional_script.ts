import { args } from "@unigent/core/args";
import { z } from "zod";

const input = await args(z.string());
process.stdout.write(`POSITIONAL INPUT: ${input}\n`);
