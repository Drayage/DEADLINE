#!/usr/bin/env node
// PostToolUse 훅: Edit/Write된 .js/.mjs/.cjs 파일에 node --check 문법 검사.
// stdin으로 훅 JSON을 받고, 문법 오류 시 exit 2 → stderr가 Claude에게 피드백됨.
let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let file = "";
  try {
    file = JSON.parse(raw).tool_input.file_path || "";
  } catch (e) {}
  if (!/\.(js|mjs|cjs)$/.test(file)) process.exit(0);

  const cp = require("child_process");
  const check = (f) => cp.spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });

  let r = check(file);
  if (
    r.status !== 0 &&
    file.endsWith(".js") &&
    /import statement|outside a module|Unexpected token 'export'|Cannot use import/i.test(r.stderr || "")
  ) {
    // 구버전 Node가 ESM .js를 CJS로 파싱해 생긴 오탐 방어: .mjs 사본으로 재검사
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const tmp = path.join(os.tmpdir(), "cc-syntax-" + process.pid + ".mjs");
    try {
      fs.copyFileSync(file, tmp);
      r = check(tmp);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {}
    }
  }

  if (r.status !== 0) {
    console.error("[syntax-check] node --check 실패 — 방금 저장한 파일에 문법 오류가 있습니다. 수정하세요:\n" + r.stderr);
    process.exit(2);
  }
});
