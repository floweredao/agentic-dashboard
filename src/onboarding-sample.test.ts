import { expect, test } from "bun:test";
import { agentRecordIssues } from "../shared/contracts";
import { applyLocale, getLocale } from "./i18n";
import { sampleRecord } from "./onboarding-sample";

test.each(["en", "ko"] as const)("the %s onboarding example satisfies the agent write contract", locale => {
  const previous = getLocale();
  try {
    applyLocale(locale);
    expect(agentRecordIssues(sampleRecord())).toEqual([]);
  } finally {
    applyLocale(previous);
  }
});
