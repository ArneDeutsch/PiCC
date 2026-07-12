import { describe, expect, it } from "vitest";
import { substituteArguments, substituteToolRules } from "../src/claude/skills.js";

/**
 * Focused tests for the Claude argument-substitution semantics (audit A1/A2)
 * and tool-rule substitution (A3): `$N` is 0-based and greedy multi-digit,
 * `\` escapes recognizable tokens, `$$` has no special meaning, and
 * allowed/disallowed-tools entries get the same variable + argument
 * substitution as the body (without the ARGUMENTS: fallback append).
 */

describe("substituteArguments: 0-based greedy $N (A1)", () => {
  it("$0 is the FIRST argument (0-based, ≡ $ARGUMENTS[0])", () => {
    const { text, diagnostics } = substituteArguments("a=$0 b=$1 a2=$ARGUMENTS[0]", "alpha beta");
    expect(text).toBe("a=alpha b=beta a2=alpha");
    expect(diagnostics).toHaveLength(0);
  });

  it("is greedy multi-digit: $10 is one token (argument index 10), not $1 + '0'", () => {
    const args = "a0 a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11";
    expect(substituteArguments("v=$10", args).text).toBe("v=a10");
    expect(substituteArguments("v=$11", args).text).toBe("v=a11");
  });

  it("$100 is ONE token: missing index → empty string + info diagnostic", () => {
    const { text, diagnostics } = substituteArguments("x=$100y", "a b c");
    expect(text).toBe("x=y");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe("info");
    expect(diagnostics[0]!.message).toContain("$100");
  });

  it("digits stop at the first non-digit character", () => {
    const { text } = substituteArguments("v=$1st", "zero one");
    expect(text).toBe("v=onest");
  });

  it("missing 0-based index substitutes empty + info diagnostic", () => {
    const { text, diagnostics } = substituteArguments("a=[$2]", "only two-args");
    expect(text).toBe("a=[]");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe("info");
  });

  it("quoted tokens count as single arguments", () => {
    const { text } = substituteArguments("a=$0 b=$1", `"two words" 'more words'`);
    expect(text).toBe("a=two words b=more words");
  });
});

describe("substituteArguments: backslash escaping (A2)", () => {
  it("\\ before $N emits the literal token without substitution", () => {
    const { text, diagnostics } = substituteArguments("use \\$0 here and $0", "val");
    expect(text).toBe("use $0 here and val");
    expect(diagnostics).toHaveLength(0);
  });

  it("\\ before $ARGUMENTS and $ARGUMENTS[n] emits the literal token", () => {
    const { text } = substituteArguments("a=\\$ARGUMENTS b=\\$ARGUMENTS[1] c=$ARGUMENTS", "x y");
    expect(text).toBe("a=$ARGUMENTS b=$ARGUMENTS[1] c=x y");
  });

  it("\\ before a declared $name emits the literal token", () => {
    const { text } = substituteArguments("lit=\\$file real=$file", "data.csv", [{ name: "file" }]);
    expect(text).toBe("lit=$file real=data.csv");
  });

  it("\\\\$N (a backslash pair) keeps BOTH backslashes and still expands (A2: pairs are not collapsed)", () => {
    const { text } = substituteArguments("v=\\\\$0", "val");
    expect(text).toBe("v=\\\\val");
  });

  it("\\\\\\$N (three backslashes) keeps the pair and the odd one escapes the token", () => {
    const { text } = substituteArguments("v=\\\\\\$0 w=$0", "val");
    expect(text).toBe("v=\\\\$0 w=val");
  });

  it("\\\\\\\\$N (four backslashes) keeps ALL four and still expands", () => {
    const { text } = substituteArguments("v=\\\\\\\\$0", "val");
    expect(text).toBe("v=\\\\\\\\val");
  });

  it("a backslash before anything else is left untouched", () => {
    const { text } = substituteArguments("path \\x and \\$undeclared stay", "");
    expect(text).toBe("path \\x and \\$undeclared stay");
  });

  it("$$ has no special meaning: each $ scans on its own", () => {
    // First $ matches nothing; `$0` after it expands.
    expect(substituteArguments("cost $$0", "five").text).toBe("cost $five");
    // A lone $$ (no token after) stays verbatim.
    expect(substituteArguments("just $$ here", "").text).toBe("just $$ here");
  });

  it("unrecognized $name stays verbatim (not escaped, not substituted)", () => {
    const { text, diagnostics } = substituteArguments("Check $PATH and $HOME", "", [
      { name: "file" },
    ]);
    expect(text).toBe("Check $PATH and $HOME");
    expect(diagnostics).toHaveLength(0);
  });

  it("escaped-only markers do not count as markers: ARGUMENTS fallback still appends", () => {
    const { text } = substituteArguments("Body with only \\$0 literal.", "extra");
    expect(text).toBe("Body with only $0 literal.\n\nARGUMENTS: extra");
  });
});

describe("substituteToolRules (A3)", () => {
  const vars = {
    CLAUDE_PROJECT_DIR: "C:/proj",
    CLAUDE_SKILL_DIR: "C:/proj/.claude/skills/x",
    CLAUDE_PLUGIN_ROOT: "C:/plugins/p",
  };

  it("substitutes ${CLAUDE_*} variables and $ARGUMENTS/$N in tool rules", () => {
    const rules = substituteToolRules(
      [
        "Read(${CLAUDE_PROJECT_DIR}/**)",
        "Bash(deploy $0:*)",
        "Bash(run $ARGUMENTS)",
        "Grep(${CLAUDE_PLUGIN_ROOT}/*)",
      ],
      "staging fast",
      vars,
    );
    expect(rules).toEqual([
      "Read(C:/proj/**)",
      "Bash(deploy staging:*)",
      "Bash(run staging fast)",
      "Grep(C:/plugins/p/*)",
    ]);
  });

  it("resolves declared $name arguments in rules", () => {
    const rules = substituteToolRules(["Bash(build --env $env)"], "--env prod", vars, [
      { name: "env" },
    ]);
    expect(rules).toEqual(["Bash(build --env prod)"]);
  });

  it("never appends the ARGUMENTS: fallback to marker-less rules", () => {
    const rules = substituteToolRules(["Read", "Write"], "some args", vars);
    expect(rules).toEqual(["Read", "Write"]);
  });

  it("returns undefined/empty inputs unchanged and does not mutate the source", () => {
    expect(substituteToolRules(undefined, "x", vars)).toBeUndefined();
    const src = ["Bash($0)"];
    const out = substituteToolRules(src, "a", vars);
    expect(out).toEqual(["Bash(a)"]);
    expect(src).toEqual(["Bash($0)"]); // per-activation copy, source untouched
  });
});
