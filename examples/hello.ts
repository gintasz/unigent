// A hello-world microfoom program.
//
// Run it:
//   microfoom run examples/hello.ts "Chuck Norris" --harness pi
//   node --import tsx examples/run.ts examples/hello.ts "Chuck Norris" --harness pi

import { foom, Program } from "@microfoom/core";
import { z } from "zod";

const name = z.string();

@foom.config({
  model: "openrouter/deepseek/deepseek-v4-flash",
})
export default class Hello extends Program(name) {
  async main(who: string): Promise<string> {
    return await this.agent
      .prose`Write a warm, one-sentence greeting for ${who} embarking on a new journey.`;
  }
}
