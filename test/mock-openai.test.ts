import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startMockModel } from "./helpers/mock-openai.js";

const MODEL = "synthetic-auth-model";
const EXPECTED_AUTHORIZATION = "Bearer synthetic-model-credential";
const WRONG_AUTHORIZATION = "Bearer wrong-synthetic-credential";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function requestCompletion(
  url: string,
  authorization?: string,
): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "synthetic request" }],
      stream: false,
    }),
  });
}

describe("mock OpenAI authorization boundary", () => {
  it("rejects invalid authorization without consuming or exposing the scripted turn", async () => {
    const scriptedText = "original scripted response";
    const mock = await startMockModel(
      [{ text: scriptedText }],
      new Map([[MODEL, digest(EXPECTED_AUTHORIZATION)]]),
    );

    try {
      const missing = await requestCompletion(mock.url);
      expect(missing.status).toBe(401);

      const wrong = await requestCompletion(mock.url, WRONG_AUTHORIZATION);
      expect(wrong.status).toBe(401);

      const correct = await requestCompletion(mock.url, EXPECTED_AUTHORIZATION);
      expect(correct.status).toBe(200);
      const completion = (await correct.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(completion.choices[0]?.message.content).toBe(scriptedText);

      expect(mock.requests.map((request) => request.authorizationValid)).toEqual([
        false,
        false,
        true,
      ]);
      for (const request of mock.requests) {
        expect(Object.keys(request).sort()).toEqual([
          "authorizationValid",
          "body",
          "messages",
          "model",
          "path",
          "requestKind",
          "sessionKind",
          "tools",
        ]);
        expect(
          Object.keys(request).filter(
            (key) => /(authorization|credential|header)/iu.test(key) && key !== "authorizationValid",
          ),
        ).toEqual([]);
        expect(JSON.stringify(request)).not.toContain(EXPECTED_AUTHORIZATION);
        expect(JSON.stringify(request)).not.toContain(WRONG_AUTHORIZATION);
      }
    } finally {
      await mock.close();
    }
  });
});
