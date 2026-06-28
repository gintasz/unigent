import { foom, Program } from "@microfoom/core";
import { z } from "zod";

@foom.config({
  model: "openrouter/deepseek/deepseek-v4-flash",
  thinking: "low",
  plugins: [],
  skills: [],
})
export default class SkillImprovement extends Program(z.void()) {
  async main(): Promise<void> {
    await this.agent.with({ label: "init-0" }).value(z.any())`
        create an empty file ./SKILL-0.md
		create an file ./CHANGES-0.md with str "Created empty file."
        call foom_return 1`;
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        await this.agent.with({ label: `init-${i}` }).value(z.any())`
                copy file ./SKILL-${i - 1}.md to ./SKILL-${i}.md using bash
                call foom_return 1`;
      }
      const batch_size = 3;
      const prompts = await this.agent
        .with({ label: `create-prd-prompts-${i}` })
        .value(z.array(z.string()))`
        write ${batch_size} prompts for a subagent.
        make_prompt(i):
            prompt = <ask it to conceptualize a software system, e.g. uber app (1 sentence description - different each time>
            prompt += <ask it to assume the role of a product owner and make decisions by itself without consulting with anyone>
            prompt += <ask it to use ./SKILL-${i}.md file by providing path to it>
            prompt += <ask it to dump PRD to ./PRD-${i}-i.md file>
        
        prompts = make_prompt(0..${batch_size})
        call foom_return with prompts array`;
      await Promise.all(
        prompts.map(
          (prompt, j) => this.agent.with({ label: `create-prd-${j}` }).value(z.any())`${prompt}`,
        ),
      );
      await this.improveSkill(i, batch_size);
    }
  }

  @foom.config({
    model: "openrouter/deepseek/deepseek-v4-pro",
    thinking: "high",
  })
  async improveSkill(iteration: number, batch_size: number): Promise<void> {
    await this.agent.value(z.any())`
        goal: create a PRD-writing skill for agent that takes in a brief description of software system and outputs a complete specification of it
        goal kpi:
            a = (vision, foresight, cohesion, human readability, coherence, production-readiness, non-mvp'ness*) of prd
            b = (word count of prd * word count of skill document)
            iq = information density & demonstrated exceptional intelligence in prd
            goal kpi = (a * iq) / b
        * non-mvp'ness - avoid traits of "v1", "good enough for mvp", "good enough for now, will improve later" in produced PRD (implicit or explicit)

        objective: maximize goal kpi
        never leak our goal or objective explicitly in skill document.
        current iteration: ${iteration}

        ./SKILL-${iteration}.md was used to produce ./PRD-${iteration}-[0..${batch_size}].md files

        read all ./PRD-${iteration}-[0..${batch_size}].md files
        make changes to ./SKILL-${iteration}.md in order to help achieve higher KPI in the next iteration.
        fix writer's based prose in ./SKILL-${iteration}.md to make it reader's based prose.
        create file ./CHANGES-${iteration}.md with 1 paragraph description of the skill changes`;
  }
}
