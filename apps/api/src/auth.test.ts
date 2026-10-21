import { describe, expect, it } from "vitest";
import {
  issueRegistrationChallenge,
  registrationChallengeIsValid,
} from "./auth.js";

const secret = "test-session-secret";

describe("registration challenges", () => {
  it("accepts a fresh challenge signed with the session secret", () => {
    const challenge = issueRegistrationChallenge(secret);
    expect(registrationChallengeIsValid(challenge, secret)).toBe(true);
  });

  it("rejects a challenge signed with another secret", () => {
    const challenge = issueRegistrationChallenge("other-secret");
    expect(registrationChallengeIsValid(challenge, secret)).toBe(false);
  });

  it("rejects an expired challenge", () => {
    const challenge = issueRegistrationChallenge(secret, Date.now() - 10 * 60 * 1000);
    expect(registrationChallengeIsValid(challenge, secret)).toBe(false);
  });

  it("rejects a tampered or malformed challenge", () => {
    const challenge = issueRegistrationChallenge(secret);
    const bytes = Buffer.from(challenge, "base64url");
    bytes[0] = bytes[0]! ^ 1;
    expect(registrationChallengeIsValid(bytes.toString("base64url"), secret)).toBe(false);
    expect(registrationChallengeIsValid("not-a-challenge", secret)).toBe(false);
  });
});
