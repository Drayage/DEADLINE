/*
 * build.js — index.template.html 의 /*__ENGINE_INLINE__*\/ 자리에 engine.js 를 인라인해
 * 자체완결 index.html 을 생성한다. (engine.js 가 단일 소스. node build.js 로 재생성.)
 */
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const engine = fs.readFileSync(path.join(dir, "engine.js"), "utf8");
const tpl = fs.readFileSync(path.join(dir, "index.template.html"), "utf8");

const marker = "/*__ENGINE_INLINE__*/";
if (!tpl.includes(marker)) {
  console.error("템플릿에 인라인 마커가 없습니다:", marker);
  process.exit(1);
}
const out = tpl.replace(marker, () => engine);
fs.writeFileSync(path.join(dir, "index.html"), out);
console.log("index.html 생성 완료 (engine 인라인,", out.length, "bytes)");
