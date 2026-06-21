import {
  VIBE_CALL_TOOL_PARAMETERS,
  VIBE_RETURN_TOOL_PARAMETERS,
  type ThoughtcodeToolParameter,
} from "thoughtcode-core";
import { Type, type Static, type TObject, type TString } from "typebox";

function thoughtcodeParametersToTypeBox<const TParameters extends readonly ThoughtcodeToolParameter[]>(
  parameters: TParameters,
): TObject<{ [TParameterName in TParameters[number]["name"]]: TString }> {
  return Type.Object(
    Object.fromEntries(
      parameters.map((parameter) => [
        parameter.name,
        Type.String({
          description: parameter.description,
        }),
      ]),
    ) as { [TParameterName in TParameters[number]["name"]]: TString },
  );
}

export const vibeCallParameters = thoughtcodeParametersToTypeBox(VIBE_CALL_TOOL_PARAMETERS);
export const vibeReturnParameters = thoughtcodeParametersToTypeBox(VIBE_RETURN_TOOL_PARAMETERS);

export type VibeCallParams = Static<typeof vibeCallParameters>;
export type VibeReturnParams = Static<typeof vibeReturnParameters>;
