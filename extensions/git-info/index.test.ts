import assert from "node:assert/strict";
import test from "node:test";
import { parseGitStatus } from "./index.ts";

test("parses porcelain v2 branch status", () => {
  assert.deepEqual(
    parseGitStatus("# branch.oid abcdef123456\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0"),
    { branch: "main", dirty: false, ahead: 0, behind: 0 },
  );
  assert.deepEqual(
    parseGitStatus("# branch.oid abcdef123456\n# branch.head main\n1 M. N... 100644 100644 100644 abc def file\n? new.txt"),
    { branch: "main", dirty: true, ahead: 0, behind: 0 },
  );
  assert.deepEqual(
    parseGitStatus("# branch.oid abcdef123456\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3"),
    { branch: "main", dirty: false, ahead: 2, behind: 3 },
  );
  assert.deepEqual(
    parseGitStatus("# branch.oid abcdef123456\n# branch.head main"),
    { branch: "main", dirty: false, ahead: 0, behind: 0 },
  );
  assert.deepEqual(
    parseGitStatus("# branch.oid abcdef123456\n# branch.head (detached)"),
    { branch: "abcdef1", dirty: false, ahead: 0, behind: 0 },
  );
  assert.deepEqual(parseGitStatus("# branch.ab invalid\nmalformed"), {
    branch: "detached",
    dirty: true,
    ahead: 0,
    behind: 0,
  });
});
