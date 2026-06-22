  There are two layers, and they get opposite treatments:

  1. Interface layer (the boundary between functions) → deterministic. Signature: name, params, types, defaults, decorators, return type. The
  call/return/throw protocol. Dispatch. Arg-binding. Isolation. Type-checking.
  2. Behavior layer (what's inside a function) → LLM-interpreted prose. The body. Control flow within it, variable tracking, the logic — all the LLM,
  statement by statement. This is the thesis. Untouched.